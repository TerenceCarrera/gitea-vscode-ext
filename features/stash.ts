import * as vscode from 'vscode';
import { execSync, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { StashInfo } from './types';

export class StashManager {
    private stashes: StashInfo[] = [];

    getRepositoryRoot(): string {
        try {
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                throw new Error('No workspace folder is open');
            }

            const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;

            if (fs.existsSync(path.join(workspaceFolder, '.git'))) {
                return workspaceFolder;
            }

            const searchGitDir = (dir: string, depth = 0): string | null => {
                if (depth > 2) return null;

                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name === '.git' && entry.isDirectory()) {
                        return dir;
                    }
                    if (entry.isDirectory() && !entry.name.startsWith('.')) {
                        const found = searchGitDir(path.join(dir, entry.name), depth + 1);
                        if (found) return found;
                    }
                }
                return null;
            };

            const repoRoot = searchGitDir(workspaceFolder);
            if (repoRoot) {
                return repoRoot;
            }

            throw new Error('No git repository found in workspace');
        } catch (error) {
            console.error('Failed to get repository root:', error);
            throw error;
        }
    }

    executeGitCommand(command: string, cwd: string): string {
        try {
            const result = execSync(command, { cwd, encoding: 'utf-8' });
            return result.trim();
        } catch (error) {
            throw new Error(`Git command failed: ${(error as Error).message}`);
        }
    }

    async listStashes(): Promise<StashInfo[]> {
        try {
            const cwd = this.getRepositoryRoot();
            const result = this.executeGitCommand('git stash list', cwd);

            if (!result) {
                this.stashes = [];
                return [];
            }

            this.stashes = result.split('\n').filter(line => line.trim()).map(line => {
                const match = line.match(/^(stash@\{\d+\}): (.+)$/);
                if (match) {
                    return {
                        id: match[1],
                        description: match[2]
                    };
                }
                return null;
            }).filter((s): s is StashInfo => s !== null);

            return this.stashes;
        } catch (error) {
            console.error('Failed to list stashes:', error);
            vscode.window.showErrorMessage(`Failed to list stashes: ${(error as Error).message}`);
            return [];
        }
    }

    async createStash(message: string | null = null): Promise<boolean> {
        try {
            const cwd = this.getRepositoryRoot();

            const branch = this.executeGitCommand('git rev-parse --abbrev-ref HEAD', cwd);
            const defaultMessage = message || `WIP on ${branch}`;

            execFileSync('git', ['stash', 'push', '-m', defaultMessage], { cwd, encoding: 'utf-8' });

            vscode.window.showInformationMessage(`Stash created: "${defaultMessage}"`);
            await this.listStashes();
            return true;
        } catch (error) {
            console.error('Failed to create stash:', error);
            vscode.window.showErrorMessage(`Failed to create stash: ${(error as Error).message}`);
            return false;
        }
    }

    async applyStash(stashId: string | null = null): Promise<boolean> {
        try {
            const cwd = this.getRepositoryRoot();

            if (!stashId) {
                const stashes = await this.listStashes();
                if (stashes.length === 0) {
                    vscode.window.showInformationMessage('No stashes available');
                    return false;
                }

                const selected = await vscode.window.showQuickPick(
                    stashes.map(s => ({ label: s.id, description: s.description, stashId: s.id })),
                    { placeHolder: 'Select a stash to apply' }
                );

                if (!selected) return false;
                stashId = selected.stashId;
            }

            this.executeGitCommand(`git stash apply ${stashId}`, cwd);
            vscode.window.showInformationMessage(`Applied stash: ${stashId}`);
            return true;
        } catch (error) {
            console.error('Failed to apply stash:', error);
            vscode.window.showErrorMessage(`Failed to apply stash: ${(error as Error).message}`);
            return false;
        }
    }

    async popStash(stashId: string | null = null): Promise<boolean> {
        try {
            const cwd = this.getRepositoryRoot();

            if (!stashId) {
                const stashes = await this.listStashes();
                if (stashes.length === 0) {
                    vscode.window.showInformationMessage('No stashes available');
                    return false;
                }

                const selected = await vscode.window.showQuickPick(
                    stashes.map(s => ({ label: s.id, description: s.description, stashId: s.id })),
                    { placeHolder: 'Select a stash to pop' }
                );

                if (!selected) return false;
                stashId = selected.stashId;
            }

            this.executeGitCommand(`git stash pop ${stashId}`, cwd);
            vscode.window.showInformationMessage(`Popped stash: ${stashId}`);
            await this.listStashes();
            return true;
        } catch (error) {
            console.error('Failed to pop stash:', error);
            vscode.window.showErrorMessage(`Failed to pop stash: ${(error as Error).message}`);
            return false;
        }
    }

    async dropStash(stashId: string | null = null): Promise<boolean> {
        try {
            const cwd = this.getRepositoryRoot();

            if (!stashId) {
                const stashes = await this.listStashes();
                if (stashes.length === 0) {
                    vscode.window.showInformationMessage('No stashes available');
                    return false;
                }

                const selected = await vscode.window.showQuickPick(
                    stashes.map(s => ({ label: s.id, description: s.description, stashId: s.id })),
                    { placeHolder: 'Select a stash to drop' }
                );

                if (!selected) return false;
                stashId = selected.stashId;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to drop ${stashId}?`,
                'Drop', 'Cancel'
            );

            if (confirm !== 'Drop') return false;

            this.executeGitCommand(`git stash drop ${stashId}`, cwd);
            vscode.window.showInformationMessage(`Dropped stash: ${stashId}`);
            await this.listStashes();
            return true;
        } catch (error) {
            console.error('Failed to drop stash:', error);
            vscode.window.showErrorMessage(`Failed to drop stash: ${(error as Error).message}`);
            return false;
        }
    }

    async showStashDiff(stashId: string | null = null): Promise<boolean> {
        try {
            const cwd = this.getRepositoryRoot();

            if (!stashId) {
                const stashes = await this.listStashes();
                if (stashes.length === 0) {
                    vscode.window.showInformationMessage('No stashes available');
                    return false;
                }

                const selected = await vscode.window.showQuickPick(
                    stashes.map(s => ({ label: s.id, description: s.description, stashId: s.id })),
                    { placeHolder: 'Select a stash to view' }
                );

                if (!selected) return false;
                stashId = selected.stashId;
            }

            const diff = this.executeGitCommand(`git stash show -p ${stashId}`, cwd);

            const outputChannel = vscode.window.createOutputChannel(`Stash: ${stashId}`);
            outputChannel.clear();
            outputChannel.append(diff);
            outputChannel.show();

            return true;
        } catch (error) {
            console.error('Failed to show stash diff:', error);
            vscode.window.showErrorMessage(`Failed to show stash diff: ${(error as Error).message}`);
            return false;
        }
    }

    async manageStashes(): Promise<void> {
        const actions = [
            { label: '📦 Stash Changes', action: 'create' },
            { label: '📋 List Stashes', action: 'list' },
            { label: '✓ Apply Stash', action: 'apply' },
            { label: '⤵️  Pop Stash', action: 'pop' },
            { label: '🗑️  Drop Stash', action: 'drop' },
            { label: '👁️  View Stash Diff', action: 'diff' }
        ];

        const selected = await vscode.window.showQuickPick(
            actions,
            { placeHolder: 'Select a stash action' }
        );

        if (!selected) return;

        switch (selected.action) {
            case 'create': {
                const message = await vscode.window.showInputBox({
                    prompt: 'Enter a stash message (optional)',
                    placeHolder: 'e.g., WIP: feature implementation'
                });
                await this.createStash(message ?? null);
                break;
            }
            case 'list': {
                const stashes = await this.listStashes();
                if (stashes.length === 0) {
                    vscode.window.showInformationMessage('No stashes available');
                } else {
                    const items = stashes.map(s => `${s.id}: ${s.description}`);
                    await vscode.window.showQuickPick(items, { placeHolder: 'Stashes' });
                }
                break;
            }
            case 'apply':
                await this.applyStash();
                break;
            case 'pop':
                await this.popStash();
                break;
            case 'drop':
                await this.dropStash();
                break;
            case 'diff':
                await this.showStashDiff();
                break;
        }
    }
}
