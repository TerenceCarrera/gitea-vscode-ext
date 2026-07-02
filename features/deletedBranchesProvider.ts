import * as vscode from 'vscode';
import * as path from 'path';
import BranchManager from './branches';
import { RepositoryProvider } from './treeProviders';
import { DeletedBranchInfo } from './types';

class DeletedBranchesProvider {
    private _onDidChangeTreeData: vscode.EventEmitter<void | undefined | null> = new vscode.EventEmitter<void | undefined | null>();
    readonly onDidChangeTreeData: vscode.Event<void | undefined | null> = this._onDidChangeTreeData.event;

    constructor(
        private branchManager: BranchManager,
        private repositoryProvider: RepositoryProvider
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: any): any {
        return element;
    }

    async getChildren(element?: any): Promise<any[]> {
        if (!element) {
            return this.getRepositoriesWithDeletedBranches();
        } else if (element.contextValue === 'deletedBranchesRepo') {
            return this.getDeletedBranchesForRepo(element.repoPath);
        }
        return [];
    }

    async getRepositoriesWithDeletedBranches(): Promise<any[]> {
        const items: any[] = [];

        for (const [repoPath, deletions] of this.branchManager.deletedBranches.entries()) {
            if (deletions.length > 0) {
                const repoName = path.basename(repoPath);
                const item: any = new vscode.TreeItem(
                    repoName,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = `${deletions.length} deleted branch${deletions.length > 1 ? 'es' : ''}`;
                item.iconPath = new vscode.ThemeIcon('repo');
                item.contextValue = 'deletedBranchesRepo';
                item.repoPath = repoPath;
                item.tooltip = `${repoPath}\n${deletions.length} deleted branch${deletions.length > 1 ? 'es' : ''}`;
                items.push(item);
            }
        }

        if (items.length === 0) {
            const emptyItem: any = new vscode.TreeItem('No deleted branches tracked');
            emptyItem.contextValue = 'empty';
            emptyItem.iconPath = new vscode.ThemeIcon('info');
            emptyItem.tooltip = 'Delete a branch through the extension to track it here, or use "Restore from Reflog" to find historical deletions';
            return [emptyItem];
        }

        return items;
    }

    getDeletedBranchesForRepo(repoPath: string): any[] {
        const deletions: DeletedBranchInfo[] = this.branchManager.getDeletedBranches(repoPath);
        const items: any[] = [];

        for (const deletion of deletions) {
            const deletedDate = new Date(deletion.deletedAt);
            const now = new Date();
            const diffMs = now.getTime() - deletedDate.getTime();
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
            const diffMinutes = Math.floor(diffMs / (1000 * 60));

            let timeAgo: string;
            if (diffDays > 0) {
                timeAgo = `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
            } else if (diffHours > 0) {
                timeAgo = `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
            } else if (diffMinutes > 0) {
                timeAgo = `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
            } else {
                timeAgo = 'just now';
            }

            const item: any = new vscode.TreeItem(deletion.name);
            item.description = timeAgo;
            item.tooltip = [
                `Branch: ${deletion.name}`,
                `Commit: ${deletion.commit.substring(0, 7)}`,
                `Deleted: ${deletedDate.toLocaleString()}`,
                `Source: ${deletion.deletedBy || 'extension'}`
            ].join('\n');
            item.iconPath = new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
            item.contextValue = 'deletedBranch';
            item.repoPath = repoPath;
            item.branchName = deletion.name;
            item.commit = deletion.commit;
            item.command = {
                command: 'gitea.showDeletedBranchDetails',
                title: 'Show Details',
                arguments: [deletion, repoPath]
            };
            items.push(item);
        }

        items.sort((a: any, b: any) => {
            const deletionA = deletions.find(d => d.name === a.branchName);
            const deletionB = deletions.find(d => d.name === b.branchName);
            if (!deletionA || !deletionB) return 0;
            return new Date(deletionB.deletedAt).getTime() - new Date(deletionA.deletedAt).getTime();
        });

        return items;
    }
}

export default DeletedBranchesProvider;
