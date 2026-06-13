const vscode = require('vscode');
const GiteaAuth = require('./features/auth');
const { RepositoryProvider, IssueProvider, PullRequestProvider } = require('./features/treeProviders');
const { PullRequestWebviewProvider, IssueWebviewProvider, PullRequestCreationProvider, VersionInfoProvider } = require('./features/webviewProviders');
const NotificationManager = require('./features/notifications');
const BranchManager = require('./features/branches');
const DeletedBranchesProvider = require('./features/deletedBranchesProvider');
const StashManager = require('./features/stash');
const { throttle } = require('./features/performanceOptimizer');
const { registerAllCommands } = require('./features/commands');

let _notificationManager = null;

async function activate(context) {
    try {
        const auth = new GiteaAuth();
        await auth.initialize();

        const repositoryProvider = new RepositoryProvider(auth);
        const issueProvider = new IssueProvider(auth);
        const pullRequestProvider = new PullRequestProvider(auth);

        const prWebviewProvider = new PullRequestWebviewProvider(auth);
        const issueWebviewProvider = new IssueWebviewProvider(auth);
        const prCreationProvider = new PullRequestCreationProvider(auth);
        const versionInfoProvider = new VersionInfoProvider(auth, context);

        const getNotificationManager = () => {
            if (!_notificationManager) {
                _notificationManager = new NotificationManager(auth);
            }
            return _notificationManager;
        };

        const branchManager = new BranchManager(auth, context);
        const deletedBranchesProvider = new DeletedBranchesProvider(branchManager, repositoryProvider);
        const stashManager = new StashManager();

        const throttledRefresh = throttle(() => {
            repositoryProvider.refresh();
            issueProvider.refresh();
            pullRequestProvider.refresh();
        }, 1000);

        let hasPromptedNoWorkspaceRepos = false;
        const getShowAllReposWhenNoWorkspace = () => {
            const config = vscode.workspace.getConfiguration('gitea');
            return !!config.get('showAllReposWhenNoWorkspace', false);
        };

        const promptNoWorkspaceRepos = async (allRepos) => {
            if (hasPromptedNoWorkspaceRepos) return null;
            hasPromptedNoWorkspaceRepos = true;

            const action = await vscode.window.showInformationMessage(
                'No Gitea repositories were found in the current workspace.',
                'Open Folder',
                'Clone Repository',
                'Show All Repos'
            );

            if (action === 'Open Folder') {
                await vscode.commands.executeCommand('vscode.openFolder');
                return 'openFolder';
            }

            if (action === 'Clone Repository') {
                const repoOptions = (allRepos || []).map(repo => ({
                    label: repo.full_name || repo.name,
                    description: repo.description || '',
                    value: repo
                }));

                const selected = await vscode.window.showQuickPick(repoOptions, {
                    placeHolder: 'Select a repository to clone'
                });

                if (selected) {
                    await vscode.commands.executeCommand('gitea.openRepository', { repository: selected.value });
                }
                return 'clone';
            }

            if (action === 'Show All Repos') {
                const config = vscode.workspace.getConfiguration('gitea');
                await config.update('showAllReposWhenNoWorkspace', true, vscode.ConfigurationTarget.Global);
                return 'showAll';
            }

            return null;
        };

        const giteaStatusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            1000
        );
        giteaStatusBar.name = 'Gitea Account';
        giteaStatusBar.tooltip = 'Click to Switch Gitea Profile/Account';

        const updateStatusBar = () => {
            const activeProfile = auth.activeProfile || 'default';
            giteaStatusBar.text = `$(account) Gitea: ${activeProfile}`;
            giteaStatusBar.command = 'gitea.switchProfile';
            giteaStatusBar.show();
        };

        updateStatusBar();
        context.subscriptions.push(giteaStatusBar);

        const repositoryTreeView = vscode.window.createTreeView('gitea.repositories', {
            treeDataProvider: repositoryProvider,
            showCollapseAll: true
        });

        const issueTreeView = vscode.window.createTreeView('gitea.issues', {
            treeDataProvider: issueProvider,
            showCollapseAll: true
        });

        const pullRequestTreeView = vscode.window.createTreeView('gitea.pullRequests', {
            treeDataProvider: pullRequestProvider,
            showCollapseAll: true
        });

        const deletedBranchesTreeView = vscode.window.createTreeView('gitea.deletedBranches', {
            treeDataProvider: deletedBranchesProvider,
            showCollapseAll: true
        });

        context.subscriptions.push(
            repositoryTreeView,
            issueTreeView,
            pullRequestTreeView,
            deletedBranchesTreeView
        );

        registerAllCommands(context, auth, {
            repositoryProvider,
            issueProvider,
            pullRequestProvider,
            prWebviewProvider,
            issueWebviewProvider,
            prCreationProvider,
            versionInfoProvider,
            branchManager,
            deletedBranchesProvider,
            stashManager,
            giteaStatusBar,
            throttledRefresh,
            getNotificationManager,
            getShowAllReposWhenNoWorkspace,
            promptNoWorkspaceRepos
        });

        (async () => {
            const switched = await auth.applyWorkspaceProfile();
            if (switched) {
                updateStatusBar();
                throttledRefresh();
            }
        })();

        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(async () => {
                const switched = await auth.applyWorkspaceProfile();
                if (switched) {
                    updateStatusBar();
                    throttledRefresh();
                }
            })
        );

        if (auth.isConfigured()) {
            try {
                const config = vscode.workspace.getConfiguration('gitea');
                if (config.get('enableNotifications')) {
                    setTimeout(() => {
                        getNotificationManager().startMonitoring().catch(err => {
                            console.error('Failed to start notifications:', err);
                        });
                    }, 2000);
                }
            } catch (error) {
                console.error('Failed to start notifications:', error);
            }
        }

        context.subscriptions.push(
            new vscode.Disposable(() => {
                try {
                    if (_notificationManager) {
                        _notificationManager.stopMonitoring();
                    }
                } catch (error) {
                    console.error('Failed to stop notifications:', error);
                }
            })
        );

        if (!auth.isConfigured()) {
            const result = await vscode.window.showInformationMessage(
                'Welcome to Gitea! Configure your instance to get started.',
                'Configure Now', 'Later'
            );
            if (result === 'Configure Now') {
                await vscode.commands.executeCommand('gitea.configure');
            }
        }
    } catch (error) {
        console.error('Failed to activate Gitea extension:', error);
        vscode.window.showErrorMessage(`Failed to activate Gitea extension: ${error.message}`);
    }
}

function deactivate() {
    if (_notificationManager) {
        _notificationManager.stopMonitoring();
        _notificationManager = null;
    }
}

module.exports = {
    activate,
    deactivate
};
