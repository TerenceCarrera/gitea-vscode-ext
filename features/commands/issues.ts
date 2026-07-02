import * as vscode from 'vscode';
import { filterRepositoriesByWorkspace } from '../treeProviders';
import { showImportIssuesDialog } from '../importIssues';
import type { CommandDeps } from '../types';
import GiteaAuth from '../auth';

export function registerCommands(context: vscode.ExtensionContext, auth: GiteaAuth, deps: CommandDeps): void {
    const { issueProvider, issueWebviewProvider, promptNoWorkspaceRepos, getShowAllReposWhenNoWorkspace } = deps;

    const searchIssuesCommand = vscode.commands.registerCommand('gitea.searchIssues', async () => {
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
                prompt: 'Search issues',
                placeHolder: 'Enter search query...'
            });

            if (query) {
                await issueProvider.searchIssues(query);
            }
        } catch (error) {
            console.error('Failed to search issues:', error);
            vscode.window.showErrorMessage(`Failed to search issues: ${error.message}`);
        }
    });

    const createIssueCommand = vscode.commands.registerCommand('gitea.createIssue', async () => {
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

            await issueWebviewProvider.showCreateIssue(workspaceRepos);

            setTimeout(() => issueProvider.refresh(), 1000);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create issue: ${error.message}`);
        }
    });

    const importIssuesCommand = vscode.commands.registerCommand('gitea.importIssues', async () => {
        console.log('[DEBUG] Import Issues command triggered');

        if (!auth.isConfigured()) {
            vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
            return;
        }

        try {
            console.log('[DEBUG] Fetching repositories...');
            const repos = await auth.makeRequest('/api/v1/user/repos');
            const allRepos = repos || [];
            let workspaceRepos = filterRepositoriesByWorkspace(allRepos);

            console.log(`[DEBUG] Found ${workspaceRepos.length} workspace repositories`);

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

            console.log('[DEBUG] Showing import dialog...');
            await showImportIssuesDialog(auth, workspaceRepos);

            setTimeout(() => issueProvider.refresh(), 1000);
        } catch (error) {
            console.error('[ERROR] Import issues command failed:', error);
            vscode.window.showErrorMessage(`Failed to import issues: ${error.message}`);
        }
    });

    const openIssueInBrowserCommand = vscode.commands.registerCommand('gitea.openIssueInBrowser', async (item) => {
        if (!item || !item.metadata) {
            vscode.window.showErrorMessage('No issue selected');
            return;
        }

        try {
            await vscode.env.openExternal(vscode.Uri.parse(item.metadata.htmlUrl));
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open browser: ${error.message}`);
        }
    });

    const viewIssueDetailsCommand = vscode.commands.registerCommand('gitea.viewIssueDetails', async (treeItem) => {
        try {
            if (treeItem && treeItem.metadata) {
                await issueWebviewProvider.showIssue(treeItem.metadata.number, treeItem.metadata.repository);
            }
        } catch (error) {
            console.error('Failed to view issue details:', error);
            vscode.window.showErrorMessage(`Failed to view issue details: ${error.message}`);
        }
    });

    context.subscriptions.push(
        searchIssuesCommand,
        createIssueCommand,
        importIssuesCommand,
        openIssueInBrowserCommand,
        viewIssueDetailsCommand
    );
}
