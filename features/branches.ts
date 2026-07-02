import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, execFileSync } from 'child_process';
import { findGitReposInDir, getRepoScanDepth } from './gitUtils';
import GiteaAuth from './auth';
import { DeletedBranchInfo } from './types';

interface BranchQuickPickItem extends vscode.QuickPickItem {
    value: string;
}

interface DeletedBranchQuickPickItem extends vscode.QuickPickItem {
    branch: DeletedBranchInfo;
}

interface DiffFileItem extends vscode.QuickPickItem {
    value: string;
    file?: string;
    status?: string;
}

interface DeletedBranchActionItem extends vscode.QuickPickItem {
    value: string;
}

interface MergeOptionItem extends vscode.QuickPickItem {
    value: string;
}

class BranchManager {
    auth: GiteaAuth;
    context: vscode.ExtensionContext;
    deletedBranches: Map<string, DeletedBranchInfo[]>;
    _savePromise?: Promise<void>;

    constructor(auth: GiteaAuth, context: vscode.ExtensionContext) {
        this.auth = auth;
        this.context = context;
        this.deletedBranches = new Map();

        this.context.globalState.setKeysForSync(['gitea.deletedBranches']);

        this.loadDeletionHistory();
    }

    loadDeletionHistory(): void {
        try {
            const stored: Record<string, DeletedBranchInfo[]> = this.context.globalState.get('giteaDeletedBranches', {});
            for (const [repoPath, deletions] of Object.entries(stored)) {
                this.deletedBranches.set(repoPath, deletions);
            }
            this.cleanupOldDeletions();
        } catch (error) {
            console.error('Failed to load deletion history:', error);
        }
    }

    saveDeletionHistory(): Promise<void> {
        this._savePromise = (this._savePromise || Promise.resolve()).then(async () => {
            try {
                const toStore: Record<string, DeletedBranchInfo[]> = {};
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

    cleanupOldDeletions(): void {
        try {
            const config = vscode.workspace.getConfiguration('gitea');
            const retentionDays: number = config.get('branchDeletionRetentionDays', 90);
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

    getRepositoryPath(repoName: string): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return null;

        const repoNameLower = repoName.toLowerCase();

        for (const folder of workspaceFolders) {
            const folderPath = folder.uri.fsPath;
            const gitRepoPaths = findGitReposInDir(folderPath, getRepoScanDepth());

            for (const repoPath of gitRepoPaths) {
                const gitConfigPath = path.join(repoPath, '.git', 'config');
                if (fs.existsSync(gitConfigPath)) {
                    try {
                        const config = fs.readFileSync(gitConfigPath, 'utf8').toLowerCase();
                        if (config.includes(`/${repoNameLower}`) ||
                            config.includes(`/${repoNameLower}.git`) ||
                            config.includes(`:${repoNameLower}.git`) ||
                            config.includes(`:${repoNameLower}/`)) {
                            return repoPath;
                        }
                    } catch {
                    }
                }
            }
        }
        return null;
    }

    async getBranches(repoPath: string): Promise<string[]> {
        try {
            const result = execSync('git branch -a', { cwd: repoPath, encoding: 'utf8' });
            const branches = result
                .split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const branch = line.replace(/^\*?\s+/, '').replace(/^remotes\/origin\//, '');
                    return branch;
                })
                .filter((branch, index, arr) => arr.indexOf(branch) === index);
            return branches;
        } catch (error) {
            throw new Error(`Failed to get branches: ${(error as Error).message}`);
        }
    }

    async getCurrentBranch(repoPath: string): Promise<string> {
        try {
            const branch = execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: repoPath,
                encoding: 'utf8'
            }).trim();
            return branch;
        } catch (error) {
            throw new Error(`Failed to get current branch: ${(error as Error).message}`);
        }
    }

    async checkoutBranch(repoPath: string, branchName: string): Promise<void> {
        try {
            execFileSync('git', ['checkout', branchName], { cwd: repoPath, stdio: 'pipe' });
            vscode.window.showInformationMessage(`Switched to branch: ${branchName}`);
        } catch (error) {
            throw new Error(`Failed to checkout branch: ${(error as Error).message}`);
        }
    }

    async createBranch(repoPath: string, branchName: string, baseBranch?: string | null): Promise<void> {
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
            throw new Error(`Failed to create branch: ${(error as Error).message}`);
        }
    }

    async createBranchFromIssue(repoName: string, issueNumber: number): Promise<void> {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const [owner, repo] = repoName.split('/');
            const issue = await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/${issueNumber}`);

            const branchName = await vscode.window.showInputBox({
                prompt: 'Branch name',
                placeHolder: `issue/${issueNumber}-${this.sanitizeBranchName(issue.title)}`,
                value: `issue/${issueNumber}-${this.sanitizeBranchName(issue.title)}`
            });

            if (!branchName) return;

            const branches = await this.getBranches(repoPath);
            const baseBranch = await vscode.window.showQuickPick(branches, {
                placeHolder: 'Select base branch'
            });

            if (!baseBranch) return;

            await this.createBranch(repoPath, branchName, baseBranch);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create branch from issue: ${(error as Error).message}`);
        }
    }

    async createBranchFromPullRequest(repoName: string, prNumber: number): Promise<void> {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const [owner, repo] = repoName.split('/');
            const pr = await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}`);

            const branchName = await vscode.window.showInputBox({
                prompt: 'Branch name',
                placeHolder: `feature/pr-${prNumber}-${this.sanitizeBranchName(pr.title)}`,
                value: `feature/pr-${prNumber}-${this.sanitizeBranchName(pr.title)}`
            });

            if (!branchName) return;

            const action = await vscode.window.showQuickPick(
                [
                    { label: 'Create from PR source branch', value: 'source' },
                    { label: 'Create from main/develop', value: 'develop' }
                ] as DeletedBranchActionItem[],
                { placeHolder: 'How would you like to create the branch?' }
            );

            if (!action) return;

            let baseBranch: string | undefined;
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
            vscode.window.showErrorMessage(`Failed to create branch from PR: ${(error as Error).message}`);
        }
    }

    async switchBranch(repoName: string): Promise<void> {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const branches = await this.getBranches(repoPath);
            const currentBranch = await this.getCurrentBranch(repoPath);

            const items: BranchQuickPickItem[] = branches.map(branch => ({
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
            vscode.window.showErrorMessage(`Failed to switch branch: ${(error as Error).message}`);
        }
    }

    sanitizeBranchName(str: string): string {
        return str
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 50);
    }

    async deleteBranch(repoPath: string, branchName: string, force: boolean = false): Promise<void> {
        try {
            const commitSha = execFileSync('git', ['rev-parse', branchName], {
                cwd: repoPath,
                encoding: 'utf8'
            }).trim();

            const deleteFlag = force ? '-D' : '-d';
            execFileSync('git', ['branch', deleteFlag, branchName], {
                cwd: repoPath,
                stdio: 'pipe'
            });

            if (!this.deletedBranches.has(repoPath)) {
                this.deletedBranches.set(repoPath, []);
            }

            this.deletedBranches.get(repoPath)!.push({
                name: branchName,
                commit: commitSha,
                deletedAt: new Date().toISOString(),
                deletedBy: 'extension'
            });

            await this.saveDeletionHistory();

            vscode.window.showInformationMessage(`Branch deleted: ${branchName}`);
        } catch (error) {
            throw new Error(`Failed to delete branch: ${(error as Error).message}`);
        }
    }

    getDeletedBranches(repoPath: string): DeletedBranchInfo[] {
        return this.deletedBranches.get(repoPath) || [];
    }

    async restoreBranch(repoPath: string, branchName: string, commitSha: string): Promise<void> {
        try {
            execFileSync('git', ['branch', branchName, commitSha], {
                cwd: repoPath,
                stdio: 'pipe'
            });

            if (this.deletedBranches.has(repoPath)) {
                const deleted = this.deletedBranches.get(repoPath)!;
                const filtered = deleted.filter(b => b.name !== branchName);
                this.deletedBranches.set(repoPath, filtered);
                await this.saveDeletionHistory();
            }

            vscode.window.showInformationMessage(`Branch restored: ${branchName}`);
        } catch (error) {
            throw new Error(`Failed to restore branch: ${(error as Error).message}`);
        }
    }

    async showDeletedBranches(repoName: string): Promise<void> {
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

            const items: DeletedBranchQuickPickItem[] = deleted.map(branch => ({
                label: `$(git-branch) ${branch.name}`,
                description: `Deleted ${new Date(branch.deletedAt).toLocaleString()}`,
                detail: `Commit: ${branch.commit.substring(0, 7)}`,
                branch: branch
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a branch to restore'
            });

            if (selected) {
                const confirm = await vscode.window.showQuickPick(
                    [
                        { label: 'Yes', value: 'Yes' },
                        { label: 'No', value: 'No' }
                    ] as DeletedBranchActionItem[],
                    {
                        placeHolder: `Restore branch "${selected.branch.name}"?`
                    }
                );

                if (confirm?.value === 'Yes') {
                    await this.restoreBranch(repoPath, selected.branch.name, selected.branch.commit);
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to show deleted branches: ${(error as Error).message}`);
        }
    }

    async restoreFromReflog(repoName: string): Promise<void> {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const reflog = execSync('git reflog --all --date=iso --no-abbrev-commit', {
                cwd: repoPath,
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024
            });

            const lines = reflog.split('\n').filter(line => line.trim());
            const deletions: DeletedBranchInfo[] = [];
            const seenBranches = new Set<string>();

            const patterns = [
                /^([a-f0-9]+).*?branch: deleted ([\w\-\/\.]+)/i,
                /^([a-f0-9]+).*?deleted remote[\s-](?:tracking )?branch ([\w\-\/\.]+)/i,
                /^([a-f0-9]+).*?branch: (?:force[\s-])?deleted ([\w\-\/\.]+)/i,
                /^([a-f0-9]+).*?update-ref.*?delete.*?refs\/heads\/([\w\-\/\.]+)/i
            ];

            for (const line of lines) {
                for (const pattern of patterns) {
                    const match = line.match(pattern);
                    if (match) {
                        const [, commit, branchName] = match;
                        const dateMatch = line.match(/\{(.+?)\}/);
                        const deletedAt = dateMatch ? dateMatch[1] : 'Unknown date';

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

            const items: DeletedBranchQuickPickItem[] = deletions.map(branch => ({
                label: `$(git-branch) ${branch.name}`,
                description: `Deleted ${branch.deletedAt}`,
                detail: `Commit: ${branch.commit.substring(0, 7)}`,
                branch: branch
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a deleted branch to restore from reflog'
            });

            if (selected) {
                const confirm = await vscode.window.showQuickPick(
                    [
                        { label: 'Yes', value: 'Yes' },
                        { label: 'No', value: 'No' }
                    ] as DeletedBranchActionItem[],
                    {
                        placeHolder: `Restore branch "${selected.branch.name}"?`
                    }
                );

                if (confirm?.value === 'Yes') {
                    await this.restoreBranch(repoPath, selected.branch.name, selected.branch.commit);
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to restore from reflog: ${(error as Error).message}`);
        }
    }

    async exportDeletionHistory(): Promise<void> {
        try {
            const history: Record<string, DeletedBranchInfo[]> = {};
            for (const [repoPath, deletions] of this.deletedBranches.entries()) {
                history[repoPath] = deletions;
            }

            const exportData = {
                version: '1.0',
                exportedAt: new Date().toISOString(),
                deletionHistory: history
            };

            const content = JSON.stringify(exportData, null, 2);

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
            throw new Error(`Failed to export deletion history: ${(error as Error).message}`);
        }
    }

    async importDeletionHistory(): Promise<void> {
        try {
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
            let importData: { version: string; deletionHistory: Record<string, DeletedBranchInfo[]> };
            try {
                importData = JSON.parse(content.toString());
            } catch {
                throw new Error('The selected file is not valid JSON');
            }

            if (!importData.version || !importData.deletionHistory) {
                throw new Error('Invalid deletion history file format');
            }

            const mergeOption = await vscode.window.showQuickPick(
                [
                    { label: 'Merge with existing history', value: 'merge', description: 'Add imported entries to current history' },
                    { label: 'Replace existing history', value: 'replace', description: 'Clear current history and use imported data' }
                ] as MergeOptionItem[],
                { placeHolder: 'How would you like to import the deletion history?' }
            );

            if (!mergeOption) return;

            if (mergeOption.value === 'replace') {
                this.deletedBranches.clear();
            }

            let importCount = 0;
            for (const [repoPath, deletions] of Object.entries(importData.deletionHistory)) {
                if (mergeOption.value === 'merge' && this.deletedBranches.has(repoPath)) {
                    const existing = this.deletedBranches.get(repoPath)!;
                    const merged: DeletedBranchInfo[] = [...existing];

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

            await this.saveDeletionHistory();
            vscode.window.showInformationMessage(`Imported ${importCount} deleted branch(es) from ${uris[0].fsPath}`);
        } catch (error) {
            throw new Error(`Failed to import deletion history: ${(error as Error).message}`);
        }
    }

    async showDiffPreview(repoPath: string, branchName: string, commitSha: string): Promise<boolean> {
        try {
            const currentBranch = await this.getCurrentBranch(repoPath);

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

            const fileList: DiffFileItem[] = diffFiles.split('\n').map(line => {
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
                    status: status,
                    value: 'preview'
                };
            });

            const selectedFile = await vscode.window.showQuickPick(
                [
                    { label: '$(check) Restore Branch', description: `Restore "${branchName}" now`, value: 'restore' },
                    { label: '$(close) Cancel', description: 'Do not restore', value: 'cancel' },
                    { label: '---', kind: vscode.QuickPickItemKind.Separator } as DiffFileItem,
                    { label: 'Preview changed files:', kind: vscode.QuickPickItemKind.Separator } as DiffFileItem,
                    ...fileList
                ] as DiffFileItem[],
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
                await this.showFileDiff(repoPath, currentBranch, commitSha, selectedFile.file);
                return await this.showDiffPreview(repoPath, branchName, commitSha);
            }

            return false;
        } catch (error) {
            console.error('Failed to show diff preview:', error);
            const proceed = await vscode.window.showWarningMessage(
                `Could not generate diff preview: ${(error as Error).message}. Restore anyway?`,
                'Restore',
                'Cancel'
            );
            return proceed === 'Restore';
        }
    }

    async showFileDiff(repoPath: string, currentBranch: string, commitSha: string, filePath: string): Promise<void> {
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
            vscode.window.showWarningMessage(`Could not show diff for ${filePath}: ${(error as Error).message}`);
        }
    }
}

export default BranchManager;
