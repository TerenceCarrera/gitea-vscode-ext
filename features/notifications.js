const vscode = require('vscode');
const { filterRepositoriesByWorkspace } = require('./treeProviders');

class NotificationManager {
    constructor(auth) {
        this.auth = auth;
        this.isMonitoring = false;
        this.pollInterval = 60000; // 60 seconds
        this.monitoringTimers = {};
        this.activityCache = {}; // Track last known state
    }

    /**
     * Start monitoring repositories for activity
     */
    async startMonitoring() {
        try {
            if (this.isMonitoring) return;

            this.isMonitoring = true;

            const config = vscode.workspace.getConfiguration('gitea');
            this.pollInterval = config.get('notificationPollInterval') || 60000;

            // Initial check
            await this.checkRepositoriesActivity();

            // Set up polling
            this.monitoringTimers.main = setInterval(async () => {
                await this.checkRepositoriesActivity();
            }, this.pollInterval);
        } catch (error) {
            console.error('Failed to start monitoring:', error);
            this.isMonitoring = false;
            vscode.window.showErrorMessage(`Failed to start repository monitoring: ${error.message}`);
        }
    }

    /**
     * Stop monitoring repositories
     */
    stopMonitoring() {
        try {
            if (!this.isMonitoring) return;

            this.isMonitoring = false;
            Object.keys(this.monitoringTimers).forEach(key => {
                clearInterval(this.monitoringTimers[key]);
            });
            this.monitoringTimers = {};
            vscode.window.showInformationMessage('Repository monitoring stopped');
        } catch (error) {
            console.error('Failed to stop monitoring:', error);
            // Don't show error to user as this is cleanup code
        }
    }

    /**
     * Check all repositories for new activities
     */
    async checkRepositoriesActivity() {
        if (!this.auth.isConfigured()) return;

        try {
            const repos = await this.auth.makeRequest('/api/v1/user/repos');
            if (!repos || repos.length === 0) return;

            const workspaceRepos = filterRepositoriesByWorkspace(repos);
            if (workspaceRepos.length === 0) return; // No workspace repos to monitor

            for (const repo of workspaceRepos) {
                await this.checkRepoActivity(repo);
            }
        } catch (error) {
            console.error('Failed to check repositories activity:', error);
        }
    }

    /**
     * Check a single repository for new activities
     */
    async checkRepoActivity(repo) {
        try {
            const repoKey = `${repo.owner.login}/${repo.name}`;

            // Check for recent activity: issues, pull requests, commits
            const [issues, prs, commits] = await Promise.all([
                this.checkNewIssues(repo, repoKey),
                this.checkNewPullRequests(repo, repoKey),
                this.checkNewCommits(repo, repoKey)
            ]);

            // Check for new issues
            if (issues.length > 0) {
                this.notifyNewIssues(repo, issues);
            }

            // Check for new pull requests
            if (prs.length > 0) {
                this.notifyNewPullRequests(repo, prs);
            }

            // Check for new commits
            if (commits.length > 0) {
                this.notifyNewCommits(repo, commits);
            }
        } catch (error) {
            console.error(`Failed to check activity for ${repo.full_name}:`, error);
        }
    }

    /**
     * Check for new issues
     */
    async checkNewIssues(repo, repoKey) {
        try {
            const issues = await this.auth.makeRequest(
                `/api/v1/repos/${repo.owner.login}/${repo.name}/issues?state=open&limit=10`
            );

            if (!Array.isArray(issues)) return [];

            // Evict cache if it grows too large (unbounded growth prevention)
            if (Object.keys(this.activityCache).length > 300) {
                this.activityCache = {};
            }

            const cacheKey = `${repoKey}:issues`;
            const previous = this.activityCache[cacheKey] || [];

            const newIssues = issues.filter(issue =>
                !issue.pull_request &&
                !previous.some(p => p.id === issue.id)
            );

            this.activityCache[cacheKey] = issues.map(i => ({ id: i.id }));
            return newIssues;
        } catch (error) {
            console.error(`Failed to check issues for ${repoKey}:`, error);
            return [];
        }
    }

    /**
     * Check for new pull requests
     */
    async checkNewPullRequests(repo, repoKey) {
        try {
            const prs = await this.auth.makeRequest(
                `/api/v1/repos/${repo.owner.login}/${repo.name}/pulls?state=open&limit=10`
            );

            if (!Array.isArray(prs)) return [];

            const cacheKey = `${repoKey}:prs`;
            const previous = this.activityCache[cacheKey] || [];

            const newPRs = prs.filter(pr =>
                !previous.some(p => p.id === pr.id)
            );

            this.activityCache[cacheKey] = prs.map(p => ({ id: p.id }));
            return newPRs;
        } catch (error) {
            console.error(`Failed to check PRs for ${repoKey}:`, error);
            return [];
        }
    }

    /**
     * Check for new commits
     */
    async checkNewCommits(repo, repoKey) {
        try {
            const commits = await this.auth.makeRequest(
                `/api/v1/repos/${repo.owner.login}/${repo.name}/commits?limit=5`
            );

            if (!commits || commits.length === 0) return [];

            const cacheKey = `${repoKey}:commits`;
            const previous = this.activityCache[cacheKey] || [];

            const newCommits = commits.filter(commit =>
                !previous.some(p => p.sha === commit.sha)
            );

            this.activityCache[cacheKey] = commits.map(c => ({ sha: c.sha }));
            return newCommits;
        } catch (error) {
            console.error(`Failed to check commits for ${repoKey}:`, error);
            return [];
        }
    }

    /**
     * Show notification for new issues
     */
    notifyNewIssues(repo, issues) {
        try {
            const count = issues.length;
            const title = count === 1 ? 'New Issue' : `${count} New Issues`;
            const message = `${title} in ${repo.full_name}`;

            const firstIssue = issues[0];
            const issueItem = {
                metadata: {
                    number: firstIssue.number,
                    repository: repo.full_name,
                    htmlUrl: firstIssue.html_url
                }
            };

            vscode.window.showInformationMessage(
                message,
                'View in VS Code',
                'Open in Browser',
                'Dismiss'
            ).then(selection => {
                if (selection === 'View in VS Code') {
                    vscode.commands.executeCommand('workbench.view.extension.gitea-explorer')
                        .then(() => vscode.commands.executeCommand('gitea.issues.focus'))
                        .catch(err => console.error('Failed to focus issues view:', err));
                } else if (selection === 'Open in Browser') {
                    vscode.commands.executeCommand('gitea.openIssueInBrowser', issueItem)
                        .then(undefined, err => console.error('Failed to open issue in browser:', err));
                }
            });
        } catch (error) {
            console.error('Failed to notify new issues:', error);
        }
    }

    /**
     * Show notification for new pull requests
     */
    notifyNewPullRequests(repo, prs) {
        try {
            const count = prs.length;
            const title = count === 1 ? 'New Pull Request' : `${count} New Pull Requests`;
            const message = `${title} in ${repo.full_name}`;

            const firstPR = prs[0];
            const prItem = {
                metadata: {
                    number: firstPR.number,
                    repository: repo.full_name,
                    htmlUrl: firstPR.html_url
                }
            };

            vscode.window.showInformationMessage(
                message,
                'View in VS Code',
                'Open in Browser',
                'Dismiss'
            ).then(selection => {
                if (selection === 'View in VS Code') {
                    vscode.commands.executeCommand('workbench.view.extension.gitea-explorer')
                        .then(() => vscode.commands.executeCommand('gitea.pullRequests.focus'))
                        .catch(err => console.error('Failed to focus pull requests view:', err));
                } else if (selection === 'Open in Browser') {
                    vscode.commands.executeCommand('gitea.openPullRequestInBrowser', prItem)
                        .then(undefined, err => console.error('Failed to open PR in browser:', err));
                }
            });
        } catch (error) {
            console.error('Failed to notify new pull requests:', error);
        }
    }

    /**
     * Show notification for new commits
     */
    notifyNewCommits(repo, commits) {
        try {
            const count = commits.length;
            const title = count === 1 ? 'New Commit' : `${count} New Commits`;
            const message = `${title} in ${repo.full_name}`;

            const firstCommit = commits[0];
            const commitUrl = firstCommit.html_url || firstCommit.url || firstCommit.htmlUrl;
            const actions = commitUrl ? ['Open in Browser', 'Copy SHA', 'Dismiss'] : ['Copy SHA', 'Dismiss'];

            vscode.window.showInformationMessage(message, ...actions).then(async selection => {
                if (selection === 'Open in Browser' && commitUrl) {
                    await vscode.env.openExternal(vscode.Uri.parse(commitUrl));
                } else if (selection === 'Copy SHA') {
                    await vscode.env.clipboard.writeText(firstCommit.sha);
                    vscode.window.showInformationMessage('Commit SHA copied to clipboard');
                }
            });
        } catch (error) {
            console.error('Failed to notify new commits:', error);
        }
    }

    /**
     * Toggle monitoring state
     */
    async toggleMonitoring() {
        try {
            if (this.isMonitoring) {
                this.stopMonitoring();
            } else {
                await this.startMonitoring();
            }
        } catch (error) {
            console.error('Failed to toggle monitoring:', error);
            vscode.window.showErrorMessage(`Failed to toggle monitoring: ${error.message}`);
        }
    }

    /**
     * Get monitoring status
     */
    getStatus() {
        return {
            isMonitoring: this.isMonitoring,
            pollInterval: this.pollInterval
        };
    }

}

module.exports = NotificationManager;
