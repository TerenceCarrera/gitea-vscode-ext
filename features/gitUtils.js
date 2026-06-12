const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { execFileSync, execSync } = require('child_process');

function getRepoScanDepth() {
    const config = vscode.workspace.getConfiguration('gitea');
    const depth = Number(config.get('repoScanDepth', 2));
    if (Number.isFinite(depth) && depth >= 0) return Math.floor(depth);
    return 2;
}

function resolveGitConfigPath(repoPath) {
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

function findGitReposInDir(dirPath, depth) {
    const foundRepos = [];
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

/**
 * Set user.name and user.email in the local git config of every workspace folder
 * that is a git repository. Silently skips folders without a .git directory.
 *
 * @param {string[]} folders     Absolute paths of workspace folders
 * @param {string}   [userName]  Git user.name (skipped if empty)
 * @param {string}   [userEmail] Git user.email (skipped if empty)
 */
function setGitUserConfig(folders, userName, userEmail) {
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

module.exports = {
    getRepoScanDepth,
    resolveGitConfigPath,
    findGitReposInDir,
    setGitUserConfig
};
