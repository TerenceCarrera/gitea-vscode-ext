const vscode = require('vscode');
const { filterRepositoriesByWorkspace } = require('../treeProviders');

function registerCommands(context, auth, deps) {
    const { branchManager, deletedBranchesProvider } = deps;

    const switchBranchCommand = vscode.commands.registerCommand('gitea.switchBranch', async (item) => {
        try {
            let repoName;

            if (item && item.metadata && item.metadata.repository) {
                repoName = item.metadata.repository;
            } else if (item && item.repository && item.repository.full_name) {
                repoName = item.repository.full_name;
            } else {
                const repos = await auth.makeRequest('/api/v1/user/repos');
                const workspaceRepos = filterRepositoriesByWorkspace(repos || []);

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

    const deleteBranchCommand = vscode.commands.registerCommand('gitea.deleteBranch', async () => {
        try {
            const repos = await auth.makeRequest('/api/v1/user/repos');
            const workspaceRepos = filterRepositoriesByWorkspace(repos || []);

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

            const branches = await branchManager.getBranches(repoPath);
            const currentBranch = await branchManager.getCurrentBranch(repoPath);

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

    const restoreDeletedBranchCommand = vscode.commands.registerCommand('gitea.restoreDeletedBranch', async () => {
        try {
            const repos = await auth.makeRequest('/api/v1/user/repos');
            const workspaceRepos = filterRepositoriesByWorkspace(repos || []);

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

    const restoreBranchFromReflogCommand = vscode.commands.registerCommand('gitea.restoreBranchFromReflog', async () => {
        try {
            const repos = await auth.makeRequest('/api/v1/user/repos');
            const workspaceRepos = filterRepositoriesByWorkspace(repos || []);

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

    const restoreBranchFromTreeCommand = vscode.commands.registerCommand('gitea.restoreBranchFromTree', async (treeItem) => {
        try {
            if (!treeItem || !treeItem.repoPath || !treeItem.branchName || !treeItem.commit) {
                vscode.window.showErrorMessage('Invalid branch selection');
                return;
            }

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

    const refreshDeletedBranchesCommand = vscode.commands.registerCommand('gitea.refreshDeletedBranches', () => {
        deletedBranchesProvider.refresh();
    });

    const exportDeletionHistoryCommand = vscode.commands.registerCommand('gitea.exportDeletionHistory', async () => {
        try {
            await branchManager.exportDeletionHistory();
        } catch (error) {
            console.error('Failed to export deletion history:', error);
            vscode.window.showErrorMessage(`Failed to export deletion history: ${error.message}`);
        }
    });

    const importDeletionHistoryCommand = vscode.commands.registerCommand('gitea.importDeletionHistory', async () => {
        try {
            await branchManager.importDeletionHistory();
            deletedBranchesProvider.refresh();
        } catch (error) {
            console.error('Failed to import deletion history:', error);
            vscode.window.showErrorMessage(`Failed to import deletion history: ${error.message}`);
        }
    });

    context.subscriptions.push(
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
        importDeletionHistoryCommand
    );
}

module.exports = { registerCommands };
