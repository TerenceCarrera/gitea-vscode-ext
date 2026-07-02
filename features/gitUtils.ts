import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync, execSync } from 'child_process';

export function getRepoScanDepth(): number {
    const config = vscode.workspace.getConfiguration('gitea');
    const depth = Number(config.get('repoScanDepth', 2));
    if (Number.isFinite(depth) && depth >= 0) return Math.floor(depth);
    return 2;
}

export function resolveGitConfigPath(repoPath: string): string | null {
    const gitEntryPath = path.join(repoPath, '.git');
    if (!fs.existsSync(gitEntryPath)) return null;

    try {
        const stat = fs.statSync(gitEntryPath);
        if (stat.isDirectory()) {
            return path.join(gitEntryPath, 'config');
        }

        const gitFile = fs.readFileSync(gitEntryPath, 'utf8');
        const match = gitFile.match(/gitdir:\s*(.+)\s*$/i);
        if (!match || !match[1]) return null;
        const gitDir = match[1].trim();
        const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(repoPath, gitDir);

        const commondirFile = path.join(resolvedGitDir, 'commondir');
        if (fs.existsSync(commondirFile)) {
            const commonRelDir = fs.readFileSync(commondirFile, 'utf8').trim();
            const commonGitDir = path.isAbsolute(commonRelDir)
                ? commonRelDir
                : path.resolve(resolvedGitDir, commonRelDir);
            return path.join(commonGitDir, 'config');
        }

        return path.join(resolvedGitDir, 'config');
    } catch (error) {
        console.error(`Failed to resolve git config path for ${repoPath}:`, error);
        return null;
    }
}

export function findGitReposInDir(dirPath: string, depth: number): string[] {
    const foundRepos: string[] = [];
    if (depth < 0) return foundRepos;
    try {
        const gitPath = path.join(dirPath, '.git');
        if (fs.existsSync(gitPath)) foundRepos.push(dirPath);
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const subDirPath = path.join(dirPath, entry.name);
                foundRepos.push(...findGitReposInDir(subDirPath, depth - 1));
            }
        }
    } catch (err) {
        console.error(`Failed to scan directory ${dirPath}:`, err);
    }
    return foundRepos;
}

export function setGitUserConfig(folders: string[], userName?: string, userEmail?: string): void {
    if (!userName && !userEmail) return;

    for (const folderPath of folders) {
        try {
            execSync('git rev-parse --git-dir', {
                cwd: folderPath,
                stdio: 'pipe',
                encoding: 'utf8',
                timeout: 5000
            });

            if (userName) {
                execFileSync('git', ['config', 'user.name', userName], {
                    cwd: folderPath,
                    stdio: 'pipe'
                });
            }
            if (userEmail) {
                execFileSync('git', ['config', 'user.email', userEmail], {
                    cwd: folderPath,
                    stdio: 'pipe'
                });
            }
        } catch {
            // skip non-git folders
        }
    }
}
