// The module 'vscode' contains the VS Code extensibility API
const vscode = require('vscode');
const GiteaAuth = require('./features/auth');
const { RepositoryProvider, IssueProvider, PullRequestProvider } = require('./features/treeProviders');
const { PullRequestWebviewProvider, IssueWebviewProvider, PullRequestCreationProvider } = require('./features/webviewProviders');
const NotificationManager = require('./features/notifications');
const BranchManager = require('./features/branches');
const DeletedBranchesProvider = require('./features/deletedBranchesProvider');
const StashManager = require('./features/stash');
const { throttle } = require('./features/performanceOptimizer');
const { showImportIssuesDialog } = require('./features/importIssues');

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    try {
        // Initialize authentication
        const auth = new GiteaAuth();
        await auth.initialize();

        // Initialize tree providers
        const repositoryProvider = new RepositoryProvider(auth);
        const issueProvider = new IssueProvider(auth);
        const pullRequestProvider = new PullRequestProvider(auth);

        // Initialize webview providers
        const prWebviewProvider = new PullRequestWebviewProvider(auth);
        const issueWebviewProvider = new IssueWebviewProvider(auth);
        const prCreationProvider = new PullRequestCreationProvider(auth);

        // Lazy-initialize notification manager (defer to reduce startup time)
        let notificationManager;
        const getNotificationManager = () => {
            if (!notificationManager) {
                notificationManager = new NotificationManager(auth);
            }
            return notificationManager;
        };

        // Initialize branch manager
        const branchManager = new BranchManager(auth, context);

        // Initialize deleted branches provider
        const deletedBranchesProvider = new DeletedBranchesProvider(branchManager, repositoryProvider);

        // Throttle refresh operations to prevent excessive API calls
        const throttledRefresh = throttle(() => {
            repositoryProvider.refresh();
            issueProvider.refresh();
            pullRequestProvider.refresh();
        }, 1000);

        // Create status bar item to show current Gitea account
        const giteaStatusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            1000 // High priority to position on the left
        );
        giteaStatusBar.name = 'Gitea Account';
        giteaStatusBar.tooltip = 'Click to Switch Gitea Profile/Account';
        // Brand color to help distinguish alongside other extensions
        // Commented out to respect user themes
        // giteaStatusBar.color = '#43a047';

        // Update status bar with current profile
        const updateStatusBar = () => {
            const activeProfile = auth.activeProfile || 'default';
            giteaStatusBar.text = `$(account) Gitea: ${activeProfile}`;
            giteaStatusBar.command = 'gitea.switchProfile';
            giteaStatusBar.show();
        };

        // Initial status bar update
        updateStatusBar();

        // Dispose status bar when extension deactivates
        context.subscriptions.push(giteaStatusBar);

    // Register tree views
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

    // Register commands

    // Configuration command
    const configureCommand = vscode.commands.registerCommand('gitea.configure', async () => {
        try {
            await auth.configure();
            repositoryProvider.refresh();
            issueProvider.refresh();
            pullRequestProvider.refresh();
        } catch (error) {
            console.error('Failed to configure Gitea:', error);
            vscode.window.showErrorMessage(`Failed to configure Gitea: ${error.message}`);
        }
    });

    // Search repositories command
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

    // Search issues command
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

    // Search pull requests command
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

    // Refresh repositories command
    const refreshRepositoriesCommand = vscode.commands.registerCommand('gitea.refreshRepositories', () => {
        try {
            repositoryProvider.resetSearch();
            issueProvider.resetSearch();
            pullRequestProvider.resetSearch();
            repositoryProvider.refresh();
            issueProvider.refresh();
            pullRequestProvider.refresh();
        } catch (error) {
            console.error('Failed to refresh repositories:', error);
            vscode.window.showErrorMessage(`Failed to refresh: ${error.message}`);
        }
    });

    // Notification monitoring command
    const toggleNotificationsCommand = vscode.commands.registerCommand('gitea.toggleNotifications', async () => {
        try {
            if (!auth.isConfigured()) {
                vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
                return;
            }
            await getNotificationManager().toggleMonitoring();
        } catch (error) {
            console.error('Failed to toggle notifications:', error);
            vscode.window.showErrorMessage(`Failed to toggle notifications: ${error.message}`);
        }
    });

    // Get notification status command
    const notificationStatusCommand = vscode.commands.registerCommand('gitea.notificationStatus', () => {
        try {
            const status = getNotificationManager().getStatus();
            const message = status.isMonitoring
                ? `Notifications enabled (polling every ${status.pollInterval / 1000}s)`
                : 'Notifications disabled';
            vscode.window.showInformationMessage(message);
        } catch (error) {
            console.error('Failed to get notification status:', error);
            vscode.window.showErrorMessage(`Failed to get notification status: ${error.message}`);
        }
    });

    // Legacy hello world command
    const helloWorldCommand = vscode.commands.registerCommand('gitea.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from Gitea!');
    });

    // Create repository command
    const createRepositoryCommand = vscode.commands.registerCommand('gitea.createRepository', async () => {
        if (!auth.isConfigured()) {
            vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
            return;
        }

        // Get organizations
        try {
            const orgs = await auth.makeRequest('/api/v1/user/orgs');
            let selectedOrg = null;

            if (orgs && orgs.length > 1) {
                // Prompt user to pick organization
                const orgOptions = orgs.map(org => ({
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

            // Get repository name
            const repoName = await vscode.window.showInputBox({
                prompt: 'Repository name',
                placeHolder: 'my-new-repo',
                validateInput: (value) => {
                    if (!value) return 'Repository name is required';
                    if (!/^[a-zA-Z0-9_-]+$/.test(value)) return 'Invalid characters. Use only alphanumeric, underscore, and dash.';
                    return null;
                }
            });

            if (!repoName) return;

            // Get repository description
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

    // Create issue command
    const createIssueCommand = vscode.commands.registerCommand('gitea.createIssue', async () => {
        if (!auth.isConfigured()) {
            vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
            return;
        }

        try {
            const repos = await auth.makeRequest('/api/v1/user/repos');
            const workspaceRepos = repositoryProvider.filterRepositoriesByWorkspace(repos || []);

            if (workspaceRepos.length === 0) {
                vscode.window.showWarningMessage('No repositories found in workspace.');
                return;
            }

            // Show WebView creation form
            await issueWebviewProvider.showCreateIssue(workspaceRepos);
            
            // Refresh after creation
            setTimeout(() => issueProvider.refresh(), 1000);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create issue: ${error.message}`);
        }
    });

        // Import issues from XLSX command
        const importIssuesCommand = vscode.commands.registerCommand('gitea.importIssues', async () => {
            console.log('[DEBUG] Import Issues command triggered');

            if (!auth.isConfigured()) {
                vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
                return;
            }

            try {
                console.log('[DEBUG] Fetching repositories...');
                const repos = await auth.makeRequest('/api/v1/user/repos');
                const workspaceRepos = repositoryProvider.filterRepositoriesByWorkspace(repos || []);

                console.log(`[DEBUG] Found ${workspaceRepos.length} workspace repositories`);

                if (workspaceRepos.length === 0) {
                    vscode.window.showWarningMessage('No repositories found in workspace.');
                    return;
                }

                // Show import dialog
                console.log('[DEBUG] Showing import dialog...');
                await showImportIssuesDialog(auth, workspaceRepos);

                // Refresh after import
                setTimeout(() => issueProvider.refresh(), 1000);
            } catch (error) {
                console.error('[ERROR] Import issues command failed:', error);
                vscode.window.showErrorMessage(`Failed to import issues: ${error.message}`);
            }
        });

    // Open repository in VS Code
    const openRepositoryCommand = vscode.commands.registerCommand('gitea.openRepository', async (item) => {
        if (!item || !item.repository) {
            vscode.window.showErrorMessage('No repository selected');
            return;
        }

        try {
            const repo = item.repository;
            const config = vscode.workspace.getConfiguration('gitea');
            const configPath = config.get('defaultRepoStartingPath');
            const defaultPath = (configPath && configPath.trim() !== '') 
                ? configPath 
                : require('path').join(require('os').homedir(), 'source', 'repos');
            const repoPath = vscode.Uri.file(require('path').join(defaultPath, repo.full_name));

            // Check if repository already exists locally
            const fs = require('fs');
            const pathExists = fs.existsSync(repoPath.fsPath);

            if (!pathExists) {
                // Ask user if they want to clone
                const result = await vscode.window.showInformationMessage(
                    `Repository not found locally. Would you like to clone it?`,
                    'Clone & Open', 'Cancel'
                );

                if (result !== 'Clone & Open') return;

                // Create parent directory if needed
                const parentDir = require('path').dirname(repoPath.fsPath);
                if (!fs.existsSync(parentDir)) {
                    fs.mkdirSync(parentDir, { recursive: true });
                }

                // Clone repository
                const terminal = vscode.window.createTerminal(`Clone ${repo.name}`);
                terminal.show();
                terminal.sendText(`git clone ${repo.clone_url} "${repoPath.fsPath}"`, true);

                // Wait a bit for clone to start, then offer to open
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
                // Repository exists, check if already open in workspace
                const workspaceFolders = vscode.workspace.workspaceFolders || [];
                const isAlreadyOpen = workspaceFolders.some(folder =>
                    folder.uri.fsPath === repoPath.fsPath
                );

                if (isAlreadyOpen) {
                    vscode.window.showInformationMessage(`Repository "${repo.name}" is already open in the workspace.`);
                    return;
                }

                // Repository exists locally but not open, ask to open it
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

    // Open repository in browser
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

    // Open issue in browser
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

    // Open pull request in browser
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

    // Create pull request command
    const createPullRequestCommand = vscode.commands.registerCommand('gitea.createPullRequest', async () => {
        if (!auth.isConfigured()) {
            vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
            return;
        }

        try {
            const repos = await auth.makeRequest('/api/v1/user/repos');
            const workspaceRepos = repositoryProvider.filterRepositoriesByWorkspace(repos || []);

            if (workspaceRepos.length === 0) {
                vscode.window.showWarningMessage('No repositories found in workspace.');
                return;
            }

            // Show WebView creation form
            await prCreationProvider.showCreatePullRequest(workspaceRepos);
            
            // Refresh after creation
            setTimeout(() => pullRequestProvider.refresh(), 1000);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create pull request: ${error.message}`);
        }
    });

    // Switch branch command
    const switchBranchCommand = vscode.commands.registerCommand('gitea.switchBranch', async (item) => {
        try {
            let repoName;
            
            // Get repo name from tree item if available
            if (item && item.metadata && item.metadata.repository) {
                repoName = item.metadata.repository;
            } else if (item && item.repository && item.repository.full_name) {
                repoName = item.repository.full_name;
            } else {
                // Prompt user to select repository
                const repos = await auth.makeRequest('/api/v1/user/repos');
                const workspaceRepos = repositoryProvider.filterRepositoriesByWorkspace(repos || []);
                
                if (workspaceRepos.length === 0) {
                    vscode.window.showWarningMessage('No repositories found in workspace.');
                    return;
                }
                
                const selected = await vscode.window.showQuickPick(
                    workspaceRepos.map(r => ({ label: r.name, value: r.full_name })),
                    { placeHolder: 'Select repository' }
                );
                
                if (!selected) return;
                repoName = selected.value;
            }
            
            await branchManager.switchBranch(repoName);
        } catch (error) {
            console.error('Failed to switch branch:', error);
            vscode.window.showErrorMessage(`Failed to switch branch: ${error.message}`);
        }
    });

    // Create branch from issue command
    const createBranchFromIssueCommand = vscode.commands.registerCommand('gitea.createBranchFromIssue', async (treeItem) => {
        try {
            if (!treeItem || !treeItem.metadata) {
                vscode.window.showErrorMessage('No issue selected');
                return;
            }
            
            const repoName = treeItem.metadata.repository;
            const issueNumber = treeItem.metadata.number;
            
            await branchManager.createBranchFromIssue(repoName, issueNumber);
        } catch (error) {
            console.error('Failed to create branch from issue:', error);
            vscode.window.showErrorMessage(`Failed to create branch from issue: ${error.message}`);
        }
    });

    // Create branch from pull request command
    const createBranchFromPRCommand = vscode.commands.registerCommand('gitea.createBranchFromPR', async (treeItem) => {
        try {
            if (!treeItem || !treeItem.metadata) {
                vscode.window.showErrorMessage('No pull request selected');
                return;
            }
            
            const repoName = treeItem.metadata.repository;
            const prNumber = treeItem.metadata.number;
            
            await branchManager.createBranchFromPullRequest(repoName, prNumber);
        } catch (error) {
            console.error('Failed to create branch from PR:', error);
            vscode.window.showErrorMessage(`Failed to create branch from PR: ${error.message}`);
        }
    });

        // Delete branch command
        const deleteBranchCommand = vscode.commands.registerCommand('gitea.deleteBranch', async () => {
            try {
                // Prompt user to select repository
                const repos = await auth.makeRequest('/api/v1/user/repos');
                const workspaceRepos = repositoryProvider.filterRepositoriesByWorkspace(repos || []);

                if (workspaceRepos.length === 0) {
                    vscode.window.showWarningMessage('No repositories found in workspace.');
                    return;
                }

                const selectedRepo = await vscode.window.showQuickPick(
                    workspaceRepos.map(r => ({ label: r.name, value: r.full_name })),
                    { placeHolder: 'Select repository' }
                );

                if (!selectedRepo) return;
                const repoName = selectedRepo.value;

                const repoPath = branchManager.getRepositoryPath(repoName);
                if (!repoPath) {
                    vscode.window.showErrorMessage('Repository not found in workspace');
                    return;
                }

                // Get branches
                const branches = await branchManager.getBranches(repoPath);
                const currentBranch = await branchManager.getCurrentBranch(repoPath);

                // Filter out current branch and HEAD
                const deletableBranches = branches.filter(b =>
                    b !== currentBranch &&
                    !b.includes('HEAD') &&
                    !b.startsWith('remotes/')
                );

                if (deletableBranches.length === 0) {
                    vscode.window.showInformationMessage('No branches available to delete');
                    return;
                }

                const selectedBranch = await vscode.window.showQuickPick(
                    deletableBranches.map(b => ({ label: b, value: b })),
                    { placeHolder: 'Select branch to delete' }
                );

                if (!selectedBranch) return;

                // Confirm deletion
                const deleteType = await vscode.window.showQuickPick(
                    [
                        { label: 'Normal Delete', description: 'Delete only if merged', value: false },
                        { label: 'Force Delete', description: 'Delete even if not merged', value: true }
                    ],
                    { placeHolder: `Delete branch "${selectedBranch.value}"?` }
                );

                if (!deleteType) return;

                await branchManager.deleteBranch(repoPath, selectedBranch.value, deleteType.value);
            } catch (error) {
                console.error('Failed to delete branch:', error);
                vscode.window.showErrorMessage(`Failed to delete branch: ${error.message}`);
            }
        });

        // Restore deleted branch command
        const restoreDeletedBranchCommand = vscode.commands.registerCommand('gitea.restoreDeletedBranch', async () => {
            try {
                // Prompt user to select repository
                const repos = await auth.makeRequest('/api/v1/user/repos');
                const workspaceRepos = repositoryProvider.filterRepositoriesByWorkspace(repos || []);

                if (workspaceRepos.length === 0) {
                    vscode.window.showWarningMessage('No repositories found in workspace.');
                    return;
                }

                const selectedRepo = await vscode.window.showQuickPick(
                    workspaceRepos.map(r => ({ label: r.name, value: r.full_name })),
                    { placeHolder: 'Select repository' }
                );

                if (!selectedRepo) return;

                await branchManager.showDeletedBranches(selectedRepo.value);
            } catch (error) {
                console.error('Failed to restore deleted branch:', error);
                vscode.window.showErrorMessage(`Failed to restore deleted branch: ${error.message}`);
            }
        });

        // Restore branch from reflog command
        const restoreBranchFromReflogCommand = vscode.commands.registerCommand('gitea.restoreBranchFromReflog', async () => {
            try {
                // Prompt user to select repository
                const repos = await auth.makeRequest('/api/v1/user/repos');
                const workspaceRepos = repositoryProvider.filterRepositoriesByWorkspace(repos || []);

                if (workspaceRepos.length === 0) {
                    vscode.window.showWarningMessage('No repositories found in workspace.');
                    return;
                }

                const selectedRepo = await vscode.window.showQuickPick(
                    workspaceRepos.map(r => ({ label: r.name, value: r.full_name })),
                    { placeHolder: 'Select repository' }
                );

                if (!selectedRepo) return;

                await branchManager.restoreFromReflog(selectedRepo.value);
                deletedBranchesProvider.refresh();
            } catch (error) {
                console.error('Failed to restore branch from reflog:', error);
                vscode.window.showErrorMessage(`Failed to restore branch from reflog: ${error.message}`);
            }
        });

        // Show deleted branch details command
        const showDeletedBranchDetailsCommand = vscode.commands.registerCommand('gitea.showDeletedBranchDetails', async (deletion, repoPath) => {
            try {
                if (!deletion || !repoPath) return;

                const deletedDate = new Date(deletion.deletedAt);
                const message = [
                    `Branch: ${deletion.name}`,
                    `Commit SHA: ${deletion.commit}`,
                    `Deleted: ${deletedDate.toLocaleString()}`,
                    `Deleted by: ${deletion.deletedBy || 'extension'}`,
                    `Repository: ${repoPath}`
                ].join('\\n');

                const action = await vscode.window.showInformationMessage(
                    message,
                    'Preview & Restore',
                    'Copy Commit SHA',
                    'Close'
                );

                if (action === 'Preview & Restore') {
                    const shouldRestore = await branchManager.showDiffPreview(repoPath, deletion.name, deletion.commit);
                    if (shouldRestore) {
                        await branchManager.restoreBranch(repoPath, deletion.name, deletion.commit);
                        deletedBranchesProvider.refresh();
                    }
                } else if (action === 'Copy Commit SHA') {
                    await vscode.env.clipboard.writeText(deletion.commit);
                    vscode.window.showInformationMessage('Commit SHA copied to clipboard');
                }
            } catch (error) {
                console.error('Failed to show deleted branch details:', error);
                vscode.window.showErrorMessage(`Failed to show details: ${error.message}`);
            }
        });

        // Restore branch from tree command
        const restoreBranchFromTreeCommand = vscode.commands.registerCommand('gitea.restoreBranchFromTree', async (treeItem) => {
            try {
                if (!treeItem || !treeItem.repoPath || !treeItem.branchName || !treeItem.commit) {
                    vscode.window.showErrorMessage('Invalid branch selection');
                    return;
                }

                // Show diff preview before restoring
                const shouldRestore = await branchManager.showDiffPreview(treeItem.repoPath, treeItem.branchName, treeItem.commit);

                if (shouldRestore) {
                    await branchManager.restoreBranch(treeItem.repoPath, treeItem.branchName, treeItem.commit);
                    deletedBranchesProvider.refresh();
                }
            } catch (error) {
                console.error('Failed to restore branch from tree:', error);
                vscode.window.showErrorMessage(`Failed to restore branch: ${error.message}`);
            }
        });

        // Remove from history command
        const removeFromHistoryCommand = vscode.commands.registerCommand('gitea.removeFromHistory', async (treeItem) => {
            try {
                if (!treeItem || !treeItem.repoPath || !treeItem.branchName) {
                    vscode.window.showErrorMessage('Invalid branch selection');
                    return;
                }

                const confirm = await vscode.window.showQuickPick(['Yes', 'No'], {
                    placeHolder: `Remove "${treeItem.branchName}" from deletion history?`
                });

                if (confirm === 'Yes') {
                    const deleted = branchManager.getDeletedBranches(treeItem.repoPath);
                    const filtered = deleted.filter(b => b.name !== treeItem.branchName);
                    branchManager.deletedBranches.set(treeItem.repoPath, filtered);
                    await branchManager.saveDeletionHistory();
                    deletedBranchesProvider.refresh();
                    vscode.window.showInformationMessage(`Removed "${treeItem.branchName}" from history`);
                }
            } catch (error) {
                console.error('Failed to remove from history:', error);
                vscode.window.showErrorMessage(`Failed to remove from history: ${error.message}`);
            }
        });

        // Clear all deletion history command
        const clearDeletionHistoryCommand = vscode.commands.registerCommand('gitea.clearDeletionHistory', async () => {
            try {
                const confirm = await vscode.window.showWarningMessage(
                    'Clear all deletion history? This cannot be undone.',
                    { modal: true },
                    'Clear All',
                    'Cancel'
                );

                if (confirm === 'Clear All') {
                    branchManager.deletedBranches.clear();
                    await branchManager.saveDeletionHistory();
                    deletedBranchesProvider.refresh();
                    vscode.window.showInformationMessage('Deletion history cleared');
                }
            } catch (error) {
                console.error('Failed to clear deletion history:', error);
                vscode.window.showErrorMessage(`Failed to clear history: ${error.message}`);
            }
        });

        // Refresh deleted branches command
        const refreshDeletedBranchesCommand = vscode.commands.registerCommand('gitea.refreshDeletedBranches', () => {
            deletedBranchesProvider.refresh();
        });

        // Export deletion history command
        const exportDeletionHistoryCommand = vscode.commands.registerCommand('gitea.exportDeletionHistory', async () => {
            try {
                await branchManager.exportDeletionHistory();
            } catch (error) {
                console.error('Failed to export deletion history:', error);
                vscode.window.showErrorMessage(`Failed to export deletion history: ${error.message}`);
            }
        });

        // Import deletion history command
        const importDeletionHistoryCommand = vscode.commands.registerCommand('gitea.importDeletionHistory', async () => {
            try {
                await branchManager.importDeletionHistory();
                deletedBranchesProvider.refresh();
            } catch (error) {
                console.error('Failed to import deletion history:', error);
                vscode.window.showErrorMessage(`Failed to import deletion history: ${error.message}`);
            }
        });

        // Initialize stash manager
        const stashManager = new StashManager();

        // Add profile command
        const addProfileCommand = vscode.commands.registerCommand('gitea.addProfile', async () => {
            try {
                const added = await auth.addProfile();
                if (added) {
                    auth.cache.clear();
                    throttledRefresh();

                    // Update status bar with new profile
                    const activeProfile = auth.activeProfile || 'default';
                    giteaStatusBar.text = `$(account) Gitea: ${activeProfile}`;
                }
            } catch (error) {
                console.error('Failed to add profile:', error);
                vscode.window.showErrorMessage(`Failed to add profile: ${error.message}`);
            }
        });

        // Stash management command
        const manageStashCommand = vscode.commands.registerCommand('gitea.manageStash', async () => {
            try {
                await stashManager.manageStashes();
            } catch (error) {
                console.error('Failed to manage stashes:', error);
                vscode.window.showErrorMessage(`Failed to manage stashes: ${error.message}`);
            }
        });

        // Switch profile command
        const switchProfileCommand = vscode.commands.registerCommand('gitea.switchProfile', async () => {
            try {
                const switched = await auth.switchProfile();
                if (switched) {
                    // Clear cache to get fresh data from new account
                    auth.cache.clear();
                    throttledRefresh();

                    // Update status bar with new profile
                    const activeProfile = auth.activeProfile || 'default';
                    giteaStatusBar.text = `$(account) Gitea: ${activeProfile}`;
                }
            } catch (error) {
                console.error('Failed to switch profile:', error);
                vscode.window.showErrorMessage(`Failed to switch profile: ${error.message}`);
            }
        });

        // Remove profile command
        const removeProfileCommand = vscode.commands.registerCommand('gitea.removeProfile', async () => {
            try {
                await auth.removeProfile();
            } catch (error) {
                console.error('Failed to remove profile:', error);
                vscode.window.showErrorMessage(`Failed to remove profile: ${error.message}`);
            }
        });

    // Add all disposables to subscriptions
    context.subscriptions.push(
        repositoryTreeView,
        issueTreeView,
        pullRequestTreeView,
        deletedBranchesTreeView,
        configureCommand,
        searchRepositoriesCommand,
        searchIssuesCommand,
        searchPullRequestsCommand,
        refreshRepositoriesCommand,
        toggleNotificationsCommand,
        notificationStatusCommand,
        createRepositoryCommand,
        createIssueCommand,
        importIssuesCommand,
        createPullRequestCommand,
        switchBranchCommand,
        createBranchFromIssueCommand,
        createBranchFromPRCommand,
        deleteBranchCommand,
        restoreDeletedBranchCommand,
        restoreBranchFromReflogCommand,
        showDeletedBranchDetailsCommand,
        restoreBranchFromTreeCommand,
        removeFromHistoryCommand,
        clearDeletionHistoryCommand,
        refreshDeletedBranchesCommand,
        exportDeletionHistoryCommand,
        importDeletionHistoryCommand,
        addProfileCommand,
        manageStashCommand,
        switchProfileCommand,
        removeProfileCommand,
        openRepositoryCommand,
        openInBrowserCommand,
        openIssueInBrowserCommand,
        openPullRequestInBrowserCommand,
        helloWorldCommand
    );

    // View Issue Details command
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

    // View Pull Request Details command
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

    // Add new commands to subscriptions
    context.subscriptions.push(
        viewIssueDetailsCommand,
        viewPullRequestDetailsCommand
    );

    // Auto-start notifications if enabled
    if (auth.isConfigured()) {
        try {
            const config = vscode.workspace.getConfiguration('gitea');
            if (config.get('enableNotifications')) {
                // Defer notification startup to avoid blocking extension activation
                setTimeout(() => {
                    getNotificationManager().startMonitoring().catch(err => {
                        console.error('Failed to start notifications:', err);
                    });
                }, 2000); // 2 second delay
            }
        } catch (error) {
            console.error('Failed to start notifications:', error);
            // Don't show error to user as this is an optional feature
        }
    }

    // Stop notifications on deactivation
    context.subscriptions.push(
        new vscode.Disposable(() => {
            try {
                if (notificationManager) {
                    notificationManager.stopMonitoring();
                }
            } catch (error) {
                console.error('Failed to stop notifications:', error);
            }
        })
    );

        // Show welcome message if not configured
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

// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
    activate,
    deactivate
}
