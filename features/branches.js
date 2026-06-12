const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { execSync, execFileSync } = require('child_process');
const { findGitReposInDir, getRepoScanDepth } = require('./gitUtils');

class BranchManager {
    constructor(auth, context) {
        this.auth = auth;
        this.context = context;
        // Track deleted branches: { repoPath: [{ name, commit, deletedAt }] }
        this.deletedBranches = new Map();

        // Enable syncing of deletion history across machines via VS Code Settings Sync
        // This allows the deletion history to sync without cluttering the settings UI
        this.context.globalState.setKeysForSync(['gitea.deletedBranches']);

        // Load persisted deletion history
        this.loadDeletionHistory();
    }

    /**
     * Load deletion history from persistent storage
     */
    loadDeletionHistory() {
        try {
            const stored = this.context.globalState.get('giteaDeletedBranches', {});
            for (const [repoPath, deletions] of Object.entries(stored)) {
                this.deletedBranches.set(repoPath, deletions);
            }
            // Clean up old deletions based on retention period
            this.cleanupOldDeletions();
        } catch (error) {
            console.error('Failed to load deletion history:', error);
        }
    }

    /**
     * Save deletion history to persistent storage (serialized to prevent race conditions)
     */
    saveDeletionHistory() {
        this._savePromise = (this._savePromise || Promise.resolve()).then(async () => {
            try {
                const toStore = {};
                for (const [repoPath, deletions] of this.deletedBranches.entries()) {
                    toStore[repoPath] = deletions;
                }
                await this.context.globalState.update('giteaDeletedBranches', toStore);
            } catch (error) {
                console.error('Failed to save deletion history:', error);
            }
        });
        return this._savePromise;
    }

    /**
     * Clean up deletions older than retention period
     */
    cleanupOldDeletions() {
        try {
            const config = vscode.workspace.getConfiguration('gitea');
            const retentionDays = config.get('branchDeletionRetentionDays', 90);
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

            for (const [repoPath, deletions] of this.deletedBranches.entries()) {
                const filtered = deletions.filter(d => {
                    const deletedDate = new Date(d.deletedAt);
                    return deletedDate >= cutoffDate;
                });
                this.deletedBranches.set(repoPath, filtered);
            }
        } catch (error) {
            console.error('Failed to cleanup old deletions:', error);
        }
    }

    /**
     * Get the repository path from the current workspace
     * @param {string} repoName - Repository name in format "owner/repo"
     * @returns {string|null} - Absolute path to the repository or null if not found
     */
    getRepositoryPath(repoName) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return null;

        const repoNameLower = repoName.toLowerCase();

        // Search through all workspace folders and their subdirectories
        for (const folder of workspaceFolders) {
            const folderPath = folder.uri.fsPath;
            const gitRepoPaths = findGitReposInDir(folderPath, getRepoScanDepth());

            for (const repoPath of gitRepoPaths) {
                const gitConfigPath = path.join(repoPath, '.git', 'config');
                if (fs.existsSync(gitConfigPath)) {
                    try {
                        const config = fs.readFileSync(gitConfigPath, 'utf8').toLowerCase();
                        // Match against various formats: full path, .git suffix, or just repo name
                        if (config.includes(`/${repoNameLower}`) ||
                            config.includes(`/${repoNameLower}.git`) ||
                            config.includes(`:${repoNameLower}.git`) ||
                            config.includes(`:${repoNameLower}/`)) {
                            return repoPath;
                        }
                    } catch {
                        // Ignore read errors
                    }
                }
            }
        }
        return null;
    }

    /**
     * Get all branches for a repository
     * @param {string} repoPath - Path to the repository
     * @returns {Promise<Array>} - Array of branch names
     */
    async getBranches(repoPath) {
        try {
            const result = execSync('git branch -a', { cwd: repoPath, encoding: 'utf8' });
            const branches = result
                .split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const branch = line.replace(/^\*?\s+/, '').replace(/^remotes\/origin\//, '');
                    return branch;
                })
                .filter((branch, index, arr) => arr.indexOf(branch) === index); // Remove duplicates
            return branches;
        } catch (error) {
            throw new Error(`Failed to get branches: ${error.message}`);
        }
    }

    /**
     * Get the current branch
     * @param {string} repoPath - Path to the repository
     * @returns {string} - Current branch name
     */
    async getCurrentBranch(repoPath) {
        try {
            const branch = execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: repoPath,
                encoding: 'utf8'
            }).trim();
            return branch;
        } catch (error) {
            throw new Error(`Failed to get current branch: ${error.message}`);
        }
    }

    /**
     * Checkout a branch
     * @param {string} repoPath - Path to the repository
     * @param {string} branchName - Branch to checkout
     * @returns {Promise<void>}
     */
    async checkoutBranch(repoPath, branchName) {
        try {
            execFileSync('git', ['checkout', branchName], { cwd: repoPath, stdio: 'pipe' });
            vscode.window.showInformationMessage(`Switched to branch: ${branchName}`);
        } catch (error) {
            throw new Error(`Failed to checkout branch: ${error.message}`);
        }
    }

    /**
     * Create a new branch
     * @param {string} repoPath - Path to the repository
     * @param {string} branchName - Name for the new branch
     * @param {string} baseBranch - Branch to create from (optional, defaults to current)
     * @returns {Promise<void>}
     */
    async createBranch(repoPath, branchName, baseBranch = null) {
        try {
            if (baseBranch) {
                execFileSync('git', ['checkout', '-b', branchName, baseBranch], {
                    cwd: repoPath,
                    stdio: 'pipe'
                });
            } else {
                execFileSync('git', ['checkout', '-b', branchName], {
                    cwd: repoPath,
                    stdio: 'pipe'
                });
            }
            vscode.window.showInformationMessage(`Branch created: ${branchName}`);
        } catch (error) {
            throw new Error(`Failed to create branch: ${error.message}`);
        }
    }

    /**
     * Create a branch from an issue
     * @param {string} repoName - Repository in format "owner/repo"
     * @param {number} issueNumber - Issue number
     * @returns {Promise<void>}
     */
    async createBranchFromIssue(repoName, issueNumber) {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const [owner, repo] = repoName.split('/');
            const issue = await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/${issueNumber}`);

            // Generate branch name from issue
            const branchName = await vscode.window.showInputBox({
                prompt: 'Branch name',
                placeHolder: `issue/${issueNumber}-${this.sanitizeBranchName(issue.title)}`,
                value: `issue/${issueNumber}-${this.sanitizeBranchName(issue.title)}`
            });

            if (!branchName) return;

            // Get base branch
            const branches = await this.getBranches(repoPath);
            const baseBranch = await vscode.window.showQuickPick(branches, {
                placeHolder: 'Select base branch'
            });

            if (!baseBranch) return;

            await this.createBranch(repoPath, branchName, baseBranch);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create branch from issue: ${error.message}`);
        }
    }

    /**
     * Create a branch from a pull request
     * @param {string} repoName - Repository in format "owner/repo"
     * @param {number} prNumber - Pull request number
     * @returns {Promise<void>}
     */
    async createBranchFromPullRequest(repoName, prNumber) {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const [owner, repo] = repoName.split('/');
            const pr = await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}`);

            // Generate branch name from PR
            const branchName = await vscode.window.showInputBox({
                prompt: 'Branch name',
                placeHolder: `feature/pr-${prNumber}-${this.sanitizeBranchName(pr.title)}`,
                value: `feature/pr-${prNumber}-${this.sanitizeBranchName(pr.title)}`
            });

            if (!branchName) return;

            // Offer to use PR's source branch or create new
            const action = await vscode.window.showQuickPick(
                [
                    { label: 'Create from PR source branch', value: 'source' },
                    { label: 'Create from main/develop', value: 'develop' }
                ],
                { placeHolder: 'How would you like to create the branch?' }
            );

            if (!action) return;

            let baseBranch;
            if (action.value === 'source') {
                baseBranch = pr.head?.ref || 'main';
            } else {
                const branches = await this.getBranches(repoPath);
                baseBranch = await vscode.window.showQuickPick(branches, {
                    placeHolder: 'Select base branch'
                });
                if (!baseBranch) return;
            }

            await this.createBranch(repoPath, branchName, baseBranch);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create branch from PR: ${error.message}`);
        }
    }

    /**
     * Switch branches with quick pick
     * @param {string} repoName - Repository in format "owner/repo"
     * @returns {Promise<void>}
     */
    async switchBranch(repoName) {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const branches = await this.getBranches(repoPath);
            const currentBranch = await this.getCurrentBranch(repoPath);

            const items = branches.map(branch => ({
                label: branch === currentBranch ? `$(check) ${branch}` : branch,
                description: branch === currentBranch ? 'current' : '',
                value: branch
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select branch to checkout'
            });

            if (selected && selected.value !== currentBranch) {
                await this.checkoutBranch(repoPath, selected.value);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to switch branch: ${error.message}`);
        }
    }

    /**
     * Sanitize a string to be a valid git branch name
     * @param {string} str - String to sanitize
     * @returns {string} - Sanitized string
     */
    sanitizeBranchName(str) {
        return str
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 50);
    }

    /**
     * Delete a branch (with tracking for restore)
     * @param {string} repoPath - Path to the repository
     * @param {string} branchName - Name of the branch to delete
     * @param {boolean} force - Force delete (even if not merged)
     * @returns {Promise<void>}
     */
    async deleteBranch(repoPath, branchName, force = false) {
        try {
            // Get the commit SHA before deleting
            const commitSha = execFileSync('git', ['rev-parse', branchName], {
                cwd: repoPath,
                encoding: 'utf8'
            }).trim();

            // Delete the branch
            const deleteFlag = force ? '-D' : '-d';
            execFileSync('git', ['branch', deleteFlag, branchName], {
                cwd: repoPath,
                stdio: 'pipe'
            });

            // Track the deletion
            if (!this.deletedBranches.has(repoPath)) {
                this.deletedBranches.set(repoPath, []);
            }

            this.deletedBranches.get(repoPath).push({
                name: branchName,
                commit: commitSha,
                deletedAt: new Date().toISOString(),
                deletedBy: 'extension'
            });

            // Save to persistent storage
            await this.saveDeletionHistory();

            vscode.window.showInformationMessage(`Branch deleted: ${branchName}`);
        } catch (error) {
            throw new Error(`Failed to delete branch: ${error.message}`);
        }
    }

    /**
     * Get recently deleted branches for a repository
     * @param {string} repoPath - Path to the repository
     * @returns {Array} - Array of deleted branch info
     */
    getDeletedBranches(repoPath) {
        return this.deletedBranches.get(repoPath) || [];
    }

    /**
     * Restore a deleted branch
     * @param {string} repoPath - Path to the repository
     * @param {string} branchName - Name of the branch to restore
     * @param {string} commitSha - Commit SHA to restore from
     * @returns {Promise<void>}
     */
    async restoreBranch(repoPath, branchName, commitSha) {
        try {
            // Create the branch at the commit SHA
            execFileSync('git', ['branch', branchName, commitSha], {
                cwd: repoPath,
                stdio: 'pipe'
            });

            // Remove from deleted branches tracking
            if (this.deletedBranches.has(repoPath)) {
                const deleted = this.deletedBranches.get(repoPath);
                const filtered = deleted.filter(b => b.name !== branchName);
                this.deletedBranches.set(repoPath, filtered);
                // Save updated history
                await this.saveDeletionHistory();
            }

            vscode.window.showInformationMessage(`Branch restored: ${branchName}`);
        } catch (error) {
            throw new Error(`Failed to restore branch: ${error.message}`);
        }
    }

    /**
     * Show deleted branches and allow restoration
     * @param {string} repoName - Repository in format "owner/repo"
     * @returns {Promise<void>}
     */
    async showDeletedBranches(repoName) {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const deleted = this.getDeletedBranches(repoPath);

            if (deleted.length === 0) {
                vscode.window.showInformationMessage('No recently deleted branches to restore');
                return;
            }

            // Show quick pick with deleted branches
            const items = deleted.map(branch => ({
                label: `$(git-branch) ${branch.name}`,
                description: `Deleted ${new Date(branch.deletedAt).toLocaleString()}`,
                detail: `Commit: ${branch.commit.substring(0, 7)}`,
                branch: branch
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a branch to restore'
            });

            if (selected) {
                const confirm = await vscode.window.showQuickPick(['Yes', 'No'], {
                    placeHolder: `Restore branch "${selected.branch.name}"?`
                });

                if (confirm === 'Yes') {
                    await this.restoreBranch(repoPath, selected.branch.name, selected.branch.commit);
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to show deleted branches: ${error.message}`);
        }
    }

    /**
     * Alternative method: Restore from reflog (for branches deleted outside the extension)
     * @param {string} repoName - Repository in format "owner/repo"
     * @returns {Promise<void>}
     */
    async restoreFromReflog(repoName) {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            // Get comprehensive reflog entries
            const reflog = execSync('git reflog --all --date=iso --no-abbrev-commit', {
                cwd: repoPath,
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large histories
            });

            const lines = reflog.split('\n').filter(line => line.trim());
            const deletions = [];
            const seenBranches = new Set();

            // Enhanced patterns for branch deletion detection
            const patterns = [
                // Standard branch deletion
                /^([a-f0-9]+).*?branch: deleted ([\w\-\/\.]+)/i,
                // Remote branch deletion
                /^([a-f0-9]+).*?deleted remote[\s-](?:tracking )?branch ([\w\-\/\.]+)/i,
                // Force delete
                /^([a-f0-9]+).*?branch: (?:force[\s-])?deleted ([\w\-\/\.]+)/i,
                // Update-ref deletions
                /^([a-f0-9]+).*?update-ref.*?delete.*?refs\/heads\/([\w\-\/\.]+)/i
            ];

            // Parse reflog for branch deletions with multiple patterns
            for (const line of lines) {
                for (const pattern of patterns) {
                    const match = line.match(pattern);
                    if (match) {
                        const [, commit, branchName] = match;
                        const dateMatch = line.match(/\{(.+?)\}/);
                        const deletedAt = dateMatch ? dateMatch[1] : 'Unknown date';

                        // Avoid duplicates
                        const key = `${branchName}:${commit.substring(0, 7)}`;
                        if (!seenBranches.has(key)) {
                            seenBranches.add(key);
                            deletions.push({
                                name: branchName,
                                commit: commit,
                                deletedAt: deletedAt,
                                deletedBy: 'reflog'
                            });
                        }
                        break;
                    }
                }
            }

            if (deletions.length === 0) {
                vscode.window.showInformationMessage('No deleted branches found in reflog');
                return;
            }

            // Show quick pick with found deletions
            const items = deletions.map(branch => ({
                label: `$(git-branch) ${branch.name}`,
                description: `Deleted ${branch.deletedAt}`,
                detail: `Commit: ${branch.commit.substring(0, 7)}`,
                branch: branch
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a deleted branch to restore from reflog'
            });

            if (selected) {
                const confirm = await vscode.window.showQuickPick(['Yes', 'No'], {
                    placeHolder: `Restore branch "${selected.branch.name}"?`
                });

                if (confirm === 'Yes') {
                    await this.restoreBranch(repoPath, selected.branch.name, selected.branch.commit);
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to restore from reflog: ${error.message}`);
        }
    }

    /**
     * Export deletion history to a JSON file
     * @returns {Promise<void>}
     */
    async exportDeletionHistory() {
        try {
            const history = {};
            for (const [repoPath, deletions] of this.deletedBranches.entries()) {
                history[repoPath] = deletions;
            }

            const exportData = {
                version: '1.0',
                exportedAt: new Date().toISOString(),
                deletionHistory: history
            };

            const content = JSON.stringify(exportData, null, 2);

            // Prompt user to save file
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`gitea-deleted-branches-${Date.now()}.json`),
                filters: {
                    'JSON Files': ['json'],
                    'All Files': ['*']
                }
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                vscode.window.showInformationMessage(`Deletion history exported to ${uri.fsPath}`);
            }
        } catch (error) {
            throw new Error(`Failed to export deletion history: ${error.message}`);
        }
    }

    /**
     * Import deletion history from a JSON file
     * @returns {Promise<void>}
     */
    async importDeletionHistory() {
        try {
            // Prompt user to select file
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'JSON Files': ['json'],
                    'All Files': ['*']
                },
                openLabel: 'Import Deletion History'
            });

            if (!uris || uris.length === 0) return;

            const content = await vscode.workspace.fs.readFile(uris[0]);
            let importData;
            try {
                importData = JSON.parse(content.toString());
            } catch {
                throw new Error('The selected file is not valid JSON');
            }

            if (!importData.version || !importData.deletionHistory) {
                throw new Error('Invalid deletion history file format');
            }

            // Ask user how to handle existing history
            const mergeOption = await vscode.window.showQuickPick(
                [
                    { label: 'Merge with existing history', value: 'merge', description: 'Add imported entries to current history' },
                    { label: 'Replace existing history', value: 'replace', description: 'Clear current history and use imported data' }
                ],
                { placeHolder: 'How would you like to import the deletion history?' }
            );

            if (!mergeOption) return;

            if (mergeOption.value === 'replace') {
                this.deletedBranches.clear();
            }

            // Import the history
            let importCount = 0;
            for (const [repoPath, deletions] of Object.entries(importData.deletionHistory)) {
                if (mergeOption.value === 'merge' && this.deletedBranches.has(repoPath)) {
                    const existing = this.deletedBranches.get(repoPath);
                    const merged = [...existing];

                    // Add new deletions that don't already exist
                    for (const deletion of deletions) {
                        const exists = existing.some(e =>
                            e.name === deletion.name && e.commit === deletion.commit
                        );
                        if (!exists) {
                            merged.push(deletion);
                            importCount++;
                        }
                    }
                    this.deletedBranches.set(repoPath, merged);
                } else {
                    this.deletedBranches.set(repoPath, deletions);
                    importCount += deletions.length;
                }
            }

            // Save to persistent storage
            await this.saveDeletionHistory();
            vscode.window.showInformationMessage(`Imported ${importCount} deleted branch(es) from ${uris[0].fsPath}`);
        } catch (error) {
            throw new Error(`Failed to import deletion history: ${error.message}`);
        }
    }

    /**
     * Show diff preview before restoring a branch
     * @param {string} repoPath - Path to the repository
     * @param {string} branchName - Name of the branch to preview
     * @param {string} commitSha - Commit SHA of the deleted branch
     * @returns {Promise<boolean>} - True if user wants to proceed with restoration
     */
    async showDiffPreview(repoPath, branchName, commitSha) {
        try {
            // Get current branch
            const currentBranch = await this.getCurrentBranch(repoPath);

            // Get list of files changed in the deleted branch's commit
            const diffFiles = execFileSync('git', ['diff', '--name-status', currentBranch, commitSha], {
                cwd: repoPath,
                encoding: 'utf8'
            }).trim();

            if (!diffFiles) {
                const proceed = await vscode.window.showInformationMessage(
                    `Branch "${branchName}" has no differences from current branch "${currentBranch}".`,
                    'Restore Anyway',
                    'Cancel'
                );
                return proceed === 'Restore Anyway';
            }

            const fileList = diffFiles.split('\n').map(line => {
                const parts = line.split('\t');
                const status = parts[0];
                const file = parts[1];
                let icon = '$(file)';
                let statusText = '';

                if (status === 'A') {
                    icon = '$(diff-added)';
                    statusText = 'Added';
                } else if (status === 'D') {
                    icon = '$(diff-removed)';
                    statusText = 'Deleted';
                } else if (status === 'M') {
                    icon = '$(diff-modified)';
                    statusText = 'Modified';
                } else if (status.startsWith('R')) {
                    icon = '$(diff-renamed)';
                    statusText = 'Renamed';
                }

                return {
                    label: `${icon} ${file}`,
                    description: statusText,
                    file: file,
                    status: status
                };
            });

            const selectedFile = await vscode.window.showQuickPick(
                [
                    { label: '$(check) Restore Branch', description: `Restore "${branchName}" now`, value: 'restore' },
                    { label: '$(close) Cancel', description: 'Do not restore', value: 'cancel' },
                    { label: '---', kind: vscode.QuickPickItemKind.Separator },
                    { label: 'Preview changed files:', kind: vscode.QuickPickItemKind.Separator },
                    ...fileList.map(f => ({ ...f, value: 'preview' }))
                ],
                {
                    placeHolder: `Preview changes in "${branchName}" (${fileList.length} file(s) changed)`
                }
            );

            if (!selectedFile) return false;

            if (selectedFile.value === 'restore') {
                return true;
            } else if (selectedFile.value === 'cancel') {
                return false;
            } else if (selectedFile.value === 'preview' && selectedFile.file) {
                // Open diff view for the selected file
                await this.showFileDiff(repoPath, currentBranch, commitSha, selectedFile.file);
                // Recursively show the preview again
                return await this.showDiffPreview(repoPath, branchName, commitSha);
            }

            return false;
        } catch (error) {
            console.error('Failed to show diff preview:', error);
            const proceed = await vscode.window.showWarningMessage(
                `Could not generate diff preview: ${error.message}. Restore anyway?`,
                'Restore',
                'Cancel'
            );
            return proceed === 'Restore';
        }
    }

    /**
     * Show diff for a specific file
     * @param {string} repoPath - Path to the repository
     * @param {string} currentBranch - Current branch name
     * @param {string} commitSha - Commit SHA to compare against
     * @param {string} filePath - File to show diff for
     */
    async showFileDiff(repoPath, currentBranch, commitSha, filePath) {
        try {
            const leftUri = vscode.Uri.parse(`git:${filePath}?${currentBranch}`);
            const rightUri = vscode.Uri.parse(`git:${filePath}?${commitSha}`);

            await vscode.commands.executeCommand(
                'vscode.diff',
                leftUri.with({ scheme: 'git', path: path.join(repoPath, filePath), query: currentBranch }),
                rightUri.with({ scheme: 'git', path: path.join(repoPath, filePath), query: commitSha }),
                `${filePath} (${currentBranch} ↔ deleted branch)`,
                { preview: true }
            );
        } catch (error) {
            vscode.window.showWarningMessage(`Could not show diff for ${filePath}: ${error.message}`);
        }
    }

}

module.exports = BranchManager;
