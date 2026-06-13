const vscode = require('vscode');
const { filterRepositoriesByWorkspace } = require('../treeProviders');

function registerCommands(context, auth, deps) {
    const { pullRequestProvider, prCreationProvider, prWebviewProvider, promptNoWorkspaceRepos, getShowAllReposWhenNoWorkspace } = deps;

    const searchPullRequestsCommand = vscode.commands.registerCommand('gitea.searchPullRequests', async () => {
        try {
            if (!auth.isConfigured()) {
                const result = await vscode.window.showWarningMessage(
                    'Gitea is not configured. Would you like to configure it now?',
                    'Configure', 'Cancel'
                );
                if (result === 'Configure') {
                    await vscode.commands.executeCommand('gitea.configure');
                }
                return;
            }

            const query = await vscode.window.showInputBox({
                prompt: 'Search pull requests',
                placeHolder: 'Enter search query...'
            });

            if (query) {
                await pullRequestProvider.searchPullRequests(query);
            }
        } catch (error) {
            console.error('Failed to search pull requests:', error);
            vscode.window.showErrorMessage(`Failed to search pull requests: ${error.message}`);
        }
    });

    const createPullRequestCommand = vscode.commands.registerCommand('gitea.createPullRequest', async () => {
        if (!auth.isConfigured()) {
            vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
            return;
        }

        try {
            const repos = await auth.makeRequest('/api/v1/user/repos');
            const allRepos = repos || [];
            let workspaceRepos = filterRepositoriesByWorkspace(allRepos);

            if (workspaceRepos.length === 0) {
                if (getShowAllReposWhenNoWorkspace()) {
                    workspaceRepos = allRepos;
                } else {
                    const action = await promptNoWorkspaceRepos(allRepos);
                    if (action === 'showAll') workspaceRepos = allRepos;
                }
            }

            if (workspaceRepos.length === 0) {
                vscode.window.showWarningMessage('No repositories available for this workspace.');
                return;
            }

            await prCreationProvider.showCreatePullRequest(workspaceRepos);

            setTimeout(() => pullRequestProvider.refresh(), 1000);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create pull request: ${error.message}`);
        }
    });

    const openPullRequestInBrowserCommand = vscode.commands.registerCommand('gitea.openPullRequestInBrowser', async (item) => {
        if (!item || !item.metadata) {
            vscode.window.showErrorMessage('No pull request selected');
            return;
        }

        try {
            await vscode.env.openExternal(vscode.Uri.parse(item.metadata.htmlUrl));
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open browser: ${error.message}`);
        }
    });

    const viewPullRequestDetailsCommand = vscode.commands.registerCommand('gitea.viewPullRequestDetails', async (treeItem) => {
        try {
            if (treeItem && treeItem.metadata) {
                await prWebviewProvider.showPullRequest(treeItem.metadata.number, treeItem.metadata.repository);
            }
        } catch (error) {
            console.error('Failed to view pull request details:', error);
            vscode.window.showErrorMessage(`Failed to view pull request details: ${error.message}`);
        }
    });

    context.subscriptions.push(
        searchPullRequestsCommand,
        createPullRequestCommand,
        openPullRequestInBrowserCommand,
        viewPullRequestDetailsCommand
    );
}

module.exports = { registerCommands };
