import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { CommandDeps } from '../types';
import GiteaAuth from '../auth';

export function registerCommands(context: vscode.ExtensionContext, auth: GiteaAuth, deps: CommandDeps): void {
    const { repositoryProvider } = deps;

    const configureCommand = vscode.commands.registerCommand('gitea.configure', async () => {
        try {
            await auth.configure();
            repositoryProvider.refresh();
            deps.issueProvider.refresh();
            deps.pullRequestProvider.refresh();
        } catch (error) {
            console.error('Failed to configure Gitea:', error);
            vscode.window.showErrorMessage(`Failed to configure Gitea: ${error.message}`);
        }
    });

    const searchRepositoriesCommand = vscode.commands.registerCommand('gitea.searchRepositories', async () => {
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
                prompt: 'Search repositories',
                placeHolder: 'Enter search query...'
            });

            if (query) {
                await repositoryProvider.searchRepositories(query);
            }
        } catch (error) {
            console.error('Failed to search repositories:', error);
            vscode.window.showErrorMessage(`Failed to search repositories: ${error.message}`);
        }
    });

    const refreshRepositoriesCommand = vscode.commands.registerCommand('gitea.refreshRepositories', () => {
        try {
            repositoryProvider.resetSearch();
            deps.issueProvider.resetSearch();
            deps.pullRequestProvider.resetSearch();
            repositoryProvider.refresh();
            deps.issueProvider.refresh();
            deps.pullRequestProvider.refresh();
        } catch (error) {
            console.error('Failed to refresh repositories:', error);
            vscode.window.showErrorMessage(`Failed to refresh: ${error.message}`);
        }
    });

    const createRepositoryCommand = vscode.commands.registerCommand('gitea.createRepository', async () => {
        if (!auth.isConfigured()) {
            vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
            return;
        }

        try {
            const orgs = await auth.makeRequest('/api/v1/user/orgs');
            let selectedOrg = null;

            if (orgs && orgs.length > 1) {
                const orgOptions: { label: string; detail: string; value: any }[] = orgs.map(org => ({
                    label: org.full_name || org.username,
                    detail: org.username,
                    value: org
                }));

                const selected = await vscode.window.showQuickPick(orgOptions, {
                    placeHolder: 'Select organization for new repository'
                });

                if (!selected) return;
                selectedOrg = selected.value;
            } else if (orgs && orgs.length === 1) {
                selectedOrg = orgs[0];
            }

            const repoName = await vscode.window.showInputBox({
                prompt: 'Repository name',
                placeHolder: 'my-new-repo',
                validateInput: (value: string) => {
                    if (!value) return 'Repository name is required';
                    if (!/^[a-zA-Z0-9_-]+$/.test(value)) return 'Invalid characters. Use only alphanumeric, underscore, and dash.';
                    return null;
                }
            });

            if (!repoName) return;

            const repoDesc = await vscode.window.showInputBox({
                prompt: 'Repository description (optional)',
                placeHolder: 'Enter description...'
            });

            const endpoint = selectedOrg
                ? `/api/v1/orgs/${selectedOrg.username}/repos`
                : '/api/v1/user/repos';

            await auth.makeRequest(endpoint, {
                method: 'POST',
                body: {
                    name: repoName,
                    description: repoDesc || '',
                    private: false
                }
            });

            vscode.window.showInformationMessage(`Repository "${repoName}" created successfully!`);
            repositoryProvider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create repository: ${error.message}`);
        }
    });

    const openRepositoryCommand = vscode.commands.registerCommand('gitea.openRepository', async (item) => {
        if (!item || !item.repository) {
            vscode.window.showErrorMessage('No repository selected');
            return;
        }

        try {
            const repo = item.repository;
            const config = vscode.workspace.getConfiguration('gitea');
            const defaultPath: string = (config.get('defaultRepoStartingPath') as string) || path.join(os.homedir(), 'source', 'repos');
            const repoPath = vscode.Uri.file(path.join(defaultPath, repo.full_name));

            const pathExists = fs.existsSync(repoPath.fsPath);

            if (!pathExists) {
                const result = await vscode.window.showInformationMessage(
                    'Repository not found locally. Would you like to clone it?',
                    'Clone & Open', 'Cancel'
                );

                if (result !== 'Clone & Open') return;

                const parentDir = path.dirname(repoPath.fsPath);
                if (!fs.existsSync(parentDir)) {
                    fs.mkdirSync(parentDir, { recursive: true });
                }

                const terminal = vscode.window.createTerminal(`Clone ${repo.name}`);
                terminal.show();
                terminal.sendText(`git clone ${repo.clone_url} "${repoPath.fsPath}"`, true);

                await new Promise(resolve => setTimeout(resolve, 2000));
                const openResult = await vscode.window.showInformationMessage(
                    'Repository cloned. Open in VS Code?',
                    'Open in Current Window', 'Open in New Window', 'Cancel'
                );

                if (openResult === 'Open in Current Window') {
                    await vscode.commands.executeCommand('vscode.openFolder', repoPath, false);
                } else if (openResult === 'Open in New Window') {
                    await vscode.commands.executeCommand('vscode.openFolder', repoPath, true);
                }
            } else {
                const workspaceFolders = vscode.workspace.workspaceFolders || [];
                const isAlreadyOpen = workspaceFolders.some((folder: vscode.WorkspaceFolder) =>
                    folder.uri.fsPath === repoPath.fsPath
                );

                if (isAlreadyOpen) {
                    vscode.window.showInformationMessage(`Repository "${repo.name}" is already open in the workspace.`);
                    return;
                }

                const openResult = await vscode.window.showInformationMessage(
                    'Repository found locally. Open in VS Code?',
                    'Open in Current Window', 'Open in New Window', 'Cancel'
                );
                if (openResult === 'Open in Current Window') {
                    await vscode.commands.executeCommand('vscode.openFolder', repoPath, false);
                } else if (openResult === 'Open in New Window') {
                    await vscode.commands.executeCommand('vscode.openFolder', repoPath, true);
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open repository: ${error.message}`);
        }
    });

    const openInBrowserCommand = vscode.commands.registerCommand('gitea.openInBrowser', async (item) => {
        if (!item || !item.repository) {
            vscode.window.showErrorMessage('No repository selected');
            return;
        }

        try {
            const repo = item.repository;
            await vscode.env.openExternal(vscode.Uri.parse(repo.html_url));
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open browser: ${error.message}`);
        }
    });

    context.subscriptions.push(
        configureCommand,
        searchRepositoriesCommand,
        refreshRepositoriesCommand,
        createRepositoryCommand,
        openRepositoryCommand,
        openInBrowserCommand
    );
}
