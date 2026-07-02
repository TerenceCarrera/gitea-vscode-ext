import * as vscode from 'vscode';
import * as fs from 'fs';
import { getRepoScanDepth, resolveGitConfigPath, findGitReposInDir } from './gitUtils';
import GiteaAuth from './auth';
import { GiteaRepository, GiteaIssue, GiteaPullRequest } from './types';

let hasPromptedNoWorkspaceRepos = false;

export function shouldShowAllReposWhenNoWorkspace(): boolean {
    const config = vscode.workspace.getConfiguration('gitea');
    return !!config.get('showAllReposWhenNoWorkspace', false);
}

export async function promptForWorkspaceRepos(allRepos: GiteaRepository[]): Promise<string | null> {
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
        return null;
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
        return null;
    }

    if (action === 'Show All Repos') {
        const config = vscode.workspace.getConfiguration('gitea');
        await config.update('showAllReposWhenNoWorkspace', true, vscode.ConfigurationTarget.Global);
        return 'showAll';
    }

    return null;
}

let _wsCache: { key: string; repos: GiteaRepository[] } | null = null;

export function invalidateWorkspaceCache(): void {
    _wsCache = null;
}

export function filterRepositoriesByWorkspace(allRepos: GiteaRepository[]): GiteaRepository[] {
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    if (workspaceFolders.length === 0) return [];
    if (!Array.isArray(allRepos)) return [];

    const folderKey = workspaceFolders.map(f => f.uri.fsPath).sort().join('|');
    const repoKey = allRepos.map(r => r.id).join(',');
    const cacheKey = `${folderKey}::${repoKey}`;

    if (_wsCache && _wsCache.key === cacheKey) {
        return _wsCache.repos;
    }

    const scanDepth = getRepoScanDepth();

    const allLocalGitPaths: string[] = [];
    for (const folder of workspaceFolders) {
        allLocalGitPaths.push(...findGitReposInDir(folder.uri.fsPath, scanDepth));
    }

    const gitConfigContents = new Map<string, string>();
    for (const localPath of allLocalGitPaths) {
        const cfgPath = resolveGitConfigPath(localPath);
        if (cfgPath && fs.existsSync(cfgPath)) {
            try {
                gitConfigContents.set(localPath, fs.readFileSync(cfgPath, 'utf8').toLowerCase());
            } catch { /* skip unreadable configs */ }
        }
    }

    const loadedRepos: GiteaRepository[] = [];
    for (const repo of allRepos) {
        const cloneUrl = repo.clone_url.toLowerCase();
        const htmlUrl = repo.html_url.toLowerCase();
        const fullName = repo.full_name.toLowerCase();

        for (const [, content] of gitConfigContents) {
            if (content.includes(cloneUrl) || content.includes(htmlUrl) || content.includes(fullName)) {
                if (!loadedRepos.some(r => r.id === repo.id)) loadedRepos.push(repo);
                break;
            }
        }
    }

    _wsCache = { key: cacheKey, repos: loadedRepos };
    return loadedRepos;
}

export class RepositoryTreeItem extends vscode.TreeItem {
    repository: GiteaRepository;
    metadata: any;

    constructor(repository: GiteaRepository, collapsibleState: vscode.TreeItemCollapsibleState) {
        super(repository.name, collapsibleState);

        this.repository = repository;
        this.description = repository.full_name;
        this.tooltip = `${repository.full_name}\n${repository.description || 'No description'}`;
        this.iconPath = new vscode.ThemeIcon('repo');
        this.contextValue = 'repository';

        this.metadata = {
            id: repository.id,
            name: repository.name,
            fullName: repository.full_name,
            owner: repository.owner?.login,
            private: repository.private,
            htmlUrl: repository.html_url,
            cloneUrl: repository.clone_url
        };
    }
}

export class IssueTreeItem extends vscode.TreeItem {
    issue: GiteaIssue;
    metadata: any;

    constructor(issue: GiteaIssue, repositoryName: string) {
        super(`#${issue.number}: ${issue.title}`, vscode.TreeItemCollapsibleState.None);

        this.issue = issue;

        const assigneePart = issue.assignees?.length > 0
            ? ` → ${issue.assignees[0].login}${issue.assignees.length > 1 ? ` +${issue.assignees.length - 1}` : ''}`
            : '';
        const labels = issue.labels || [];
        const labelPart = labels.length > 0
            ? ` [${labels.slice(0, 2).map(l => l.name).join(', ')}${labels.length > 2 ? ` +${labels.length - 2}` : ''}]`
            : '';
        this.description = `${repositoryName} • ${issue.user?.login || '?'}${assigneePart}${labelPart}`;

        const labelNames = labels.map(l => l.name).join(', ') || 'None';
        const assigneeNames = issue.assignees?.map(a => a.login).join(', ') || 'Unassigned';
        const milestone = issue.milestone?.title || 'None';
        const updated = issue.updated_at ? new Date(issue.updated_at).toLocaleDateString() : '';
        const tip = new vscode.MarkdownString(
            `**#${issue.number}: ${issue.title}**\n\n` +
            `Repository: \`${repositoryName}\`  \n` +
            `Author: ${issue.user?.login || '?'}  \n` +
            `State: **${issue.state}**  \n` +
            `Assignees: ${assigneeNames}  \n` +
            `Labels: ${labelNames}  \n` +
            `Milestone: ${milestone}  \n` +
            (updated ? `Updated: ${updated}` : '')
        );
        tip.supportThemeIcons = true;
        this.tooltip = tip;

        this.iconPath = new vscode.ThemeIcon(
            issue.state === 'open' ? 'issue-opened' : 'issue-closed',
            issue.state === 'open' ? new vscode.ThemeColor('issues.open') : new vscode.ThemeColor('issues.closed')
        );

        this.contextValue = 'issue';
        this.metadata = {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            repository: repositoryName,
            htmlUrl: issue.html_url,
            assignees: issue.assignees || [],
            labels: labels,
            milestone: issue.milestone || null
        };
    }
}

export class PullRequestTreeItem extends vscode.TreeItem {
    pullRequest: GiteaPullRequest;
    metadata: any;

    constructor(pullRequest: GiteaPullRequest, repositoryName: string) {
        super(`#${pullRequest.number}: ${pullRequest.title}`, vscode.TreeItemCollapsibleState.None);

        this.pullRequest = pullRequest;

        const assigneePart = pullRequest.assignees?.length > 0
            ? ` → ${pullRequest.assignees[0].login}`
            : '';
        const draftBadge = pullRequest.draft ? ' [Draft]' : '';
        this.description = `${repositoryName} • ${pullRequest.user?.login || '?'}${assigneePart}${draftBadge}`;

        const assigneeNames = pullRequest.assignees?.map(a => a.login).join(', ') || 'Unassigned';
        const headBranch = pullRequest.head?.ref || '?';
        const baseBranch = pullRequest.base?.ref || '?';
        const updated = pullRequest.updated_at ? new Date(pullRequest.updated_at).toLocaleDateString() : '';
        const stateLabel = pullRequest.merged ? 'Merged' : (pullRequest.draft ? 'Draft' : pullRequest.state);
        const tip = new vscode.MarkdownString(
            `**#${pullRequest.number}: ${pullRequest.title}**\n\n` +
            `Repository: \`${repositoryName}\`  \n` +
            `Author: ${pullRequest.user?.login || '?'}  \n` +
            `State: **${stateLabel}**  \n` +
            `Branch: \`${headBranch}\` → \`${baseBranch}\`  \n` +
            `Assignees: ${assigneeNames}  \n` +
            (updated ? `Updated: ${updated}` : '')
        );
        tip.supportThemeIcons = true;
        this.tooltip = tip;

        let iconName = 'git-pull-request';
        let iconColor = new vscode.ThemeColor('pullRequests.open');
        if (pullRequest.merged) {
            iconName = 'git-merge';
            iconColor = new vscode.ThemeColor('pullRequests.merged');
        } else if (pullRequest.state === 'closed') {
            iconName = 'git-pull-request-closed';
            iconColor = new vscode.ThemeColor('pullRequests.closed');
        } else if (pullRequest.draft) {
            iconName = 'git-pull-request-draft';
        }

        this.iconPath = new vscode.ThemeIcon(iconName, iconColor);
        this.contextValue = 'pullRequest';
        this.metadata = {
            number: pullRequest.number,
            title: pullRequest.title,
            state: pullRequest.state,
            repository: repositoryName,
            htmlUrl: pullRequest.html_url,
            draft: pullRequest.draft || false,
            head: headBranch,
            base: baseBranch
        };
    }
}

export class RepositoryProvider {
    auth: GiteaAuth;
    private _onDidChangeTreeData: vscode.EventEmitter<void | undefined | null | void>;
    readonly onDidChangeTreeData: vscode.Event<void | undefined | null | void>;
    repositories: GiteaRepository[];
    mode: string;
    lastQuery: string;

    constructor(auth: GiteaAuth) {
        this.auth = auth;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.repositories = [];
        this.mode = 'all';
        this.lastQuery = '';
    }

    refresh(): void {
        invalidateWorkspaceCache();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: any): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: any): Promise<any[]> {
        if (!this.auth.isConfigured()) return [];
        try {
            if (!element) {
                if (this.mode === 'search') {
                    return (this.repositories || []).map(repo => new RepositoryTreeItem(repo, vscode.TreeItemCollapsibleState.None));
                }
                const repos = await this.auth.makeRequest('/api/v1/user/repos');
                const allRepos: GiteaRepository[] = repos || [];
                let workspaceRepos = filterRepositoriesByWorkspace(allRepos);

                if (workspaceRepos.length === 0) {
                    if (shouldShowAllReposWhenNoWorkspace()) {
                        workspaceRepos = allRepos;
                    } else {
                        const action = await promptForWorkspaceRepos(allRepos);
                        if (action === 'showAll') workspaceRepos = allRepos;
                    }
                }

                this.repositories = workspaceRepos;
                this.mode = 'all';
                return this.repositories.map(repo => new RepositoryTreeItem(repo, vscode.TreeItemCollapsibleState.None));
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to load repositories: ${error.message}`);
        }
        return [];
    }

    async searchRepositories(query: string): Promise<void> {
        try {
            const repos = await this.auth.makeRequest(`/api/v1/repos/search?q=${encodeURIComponent(query)}`);
            this.repositories = repos?.data || [];
            this.mode = 'search';
            this.lastQuery = query;
            this.refresh();
        } catch (error: any) { vscode.window.showErrorMessage(`Failed to search repositories: ${error.message}`); }
    }

    resetSearch(): void { this.mode = 'all'; this.lastQuery = ''; this.repositories = []; }
}

export class IssueProvider {
    auth: GiteaAuth;
    private _onDidChangeTreeData: vscode.EventEmitter<void | undefined | null | void>;
    readonly onDidChangeTreeData: vscode.Event<void | undefined | null | void>;
    issues: any;
    mode: string;
    lastQuery: string;
    private _loading: boolean;

    constructor(auth: GiteaAuth) {
        this.auth = auth;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.issues = { openByRepo: {}, closedByRepo: {} };
        this.mode = 'all';
        this.lastQuery = '';
        this._loading = false;
    }

    refresh(): void {
        invalidateWorkspaceCache();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: any): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: any): Promise<any[]> {
        if (!this.auth.isConfigured()) return [];
        try {
            if (!element) {
                if (this.mode === 'search') return this.issues;

                if (this._loading) return [];
                this._loading = true;

                try {
                    const repos = await this.auth.makeRequest('/api/v1/user/repos');
                    const allRepos: GiteaRepository[] = repos || [];
                    let workspaceRepos = filterRepositoriesByWorkspace(allRepos);

                    if (workspaceRepos.length === 0) {
                        if (shouldShowAllReposWhenNoWorkspace()) {
                            workspaceRepos = allRepos;
                        } else {
                            const action = await promptForWorkspaceRepos(allRepos);
                            if (action === 'showAll') workspaceRepos = allRepos;
                        }
                    }

                    const repoResults = await Promise.all(workspaceRepos.map(async repo => {
                        try {
                            const [openIssues, closedIssues] = await Promise.all([
                                this.auth.makeRequest(
                                    `/api/v1/repos/${repo.owner!.login}/${repo.name}/issues?state=open&type=issues&limit=50`
                                ),
                                this.auth.makeRequest(
                                    `/api/v1/repos/${repo.owner!.login}/${repo.name}/issues?state=closed&type=issues&limit=50`
                                )
                            ]);
                            return {
                                repo,
                                open: Array.isArray(openIssues) ? openIssues : [],
                                closed: Array.isArray(closedIssues) ? closedIssues : []
                            };
                        } catch (err) {
                            console.error(`Failed to fetch issues for ${repo.full_name}:`, err);
                            return { repo, open: [], closed: [] };
                        }
                    }));

                    const openByRepo: any = {};
                    const closedByRepo: any = {};
                    for (const { repo, open, closed } of repoResults) {
                        const openItems = open.map((issue: GiteaIssue) => new IssueTreeItem(issue, repo.full_name));
                        const closedItems = closed.map((issue: GiteaIssue) => new IssueTreeItem(issue, repo.full_name));
                        if (openItems.length > 0) openByRepo[repo.full_name] = openItems;
                        if (closedItems.length > 0) closedByRepo[repo.full_name] = closedItems;
                    }

                    this.issues = { openByRepo, closedByRepo };
                    this.mode = 'all';

                    const repoNames = new Set([...Object.keys(openByRepo), ...Object.keys(closedByRepo)]);
                    return Array.from(repoNames).map(repoName => {
                        const total = (openByRepo[repoName]?.length || 0) + (closedByRepo[repoName]?.length || 0);
                        const repoGroup = new vscode.TreeItem(`${repoName} (${total})`, vscode.TreeItemCollapsibleState.Collapsed);
                        repoGroup.contextValue = 'issueRepoGroup';
                        repoGroup.iconPath = new vscode.ThemeIcon('repo');
                        repoGroup.id = `repo:${repoName}`;
                        return repoGroup;
                    });
                } finally {
                    this._loading = false;
                }
            }

            if (element.contextValue === 'issueRepoGroup') {
                const repoName = element.id.substring('repo:'.length);
                const openCount = this.issues.openByRepo[repoName]?.length || 0;
                const closedCount = this.issues.closedByRepo[repoName]?.length || 0;
                const openGroup = new vscode.TreeItem(`Open (${openCount})`, vscode.TreeItemCollapsibleState.Expanded);
                openGroup.contextValue = 'issueStateGroup';
                openGroup.iconPath = new vscode.ThemeIcon('issues');
                openGroup.id = `repo:${repoName}:open`;
                const closedGroup = new vscode.TreeItem(`Closed (${closedCount})`, vscode.TreeItemCollapsibleState.Collapsed);
                closedGroup.contextValue = 'issueStateGroup';
                closedGroup.iconPath = new vscode.ThemeIcon('issue-closed');
                closedGroup.id = `repo:${repoName}:closed`;
                return [openGroup, closedGroup];
            }

            if (element.contextValue === 'issueStateGroup') {
                const parts = element.id.split(':');
                if (parts.length < 3) return [];
                const repoName = parts[1];
                const state = parts[2];
                const repoMap = state === 'open' ? this.issues.openByRepo : this.issues.closedByRepo;
                return repoMap[repoName] || [];
            }
        } catch (error: any) {
            this._loading = false;
            vscode.window.showErrorMessage(`Failed to load issues: ${error.message}`);
        }
        return [];
    }

    async searchIssues(query: string): Promise<void> {
        try {
            const repos = await this.auth.makeRequest('/api/v1/user/repos');
            const allRepos: GiteaRepository[] = repos || [];
            let workspaceRepos = filterRepositoriesByWorkspace(allRepos);

            if (workspaceRepos.length === 0) {
                if (shouldShowAllReposWhenNoWorkspace()) {
                    workspaceRepos = allRepos;
                } else {
                    const action = await promptForWorkspaceRepos(allRepos);
                    if (action === 'showAll') workspaceRepos = allRepos;
                }
            }

            const allIssues: IssueTreeItem[] = [];
            await Promise.all(workspaceRepos.map(async repo => {
                try {
                    const issues = await this.auth.makeRequest(
                        `/api/v1/repos/${repo.owner!.login}/${repo.name}/issues?q=${encodeURIComponent(query)}&state=all&type=issues&limit=50`
                    );
                    if (Array.isArray(issues)) {
                        issues.forEach((issue: GiteaIssue) => allIssues.push(new IssueTreeItem(issue, repo.full_name)));
                    }
                } catch (err) { console.error(`Failed to search issues in ${repo.full_name}:`, err); }
            }));

            this.issues = allIssues;
            this.mode = 'search';
            this.lastQuery = query;
            this.refresh();
        } catch (error: any) { vscode.window.showErrorMessage(`Failed to search issues: ${error.message}`); }
    }

    resetSearch(): void { this.mode = 'all'; this.lastQuery = ''; this.issues = { openByRepo: {}, closedByRepo: {} }; }
}

export class PullRequestProvider {
    auth: GiteaAuth;
    private _onDidChangeTreeData: vscode.EventEmitter<void | undefined | null | void>;
    readonly onDidChangeTreeData: vscode.Event<void | undefined | null | void>;
    pullRequests: any;
    mode: string;
    lastQuery: string;
    private _loading: boolean;

    constructor(auth: GiteaAuth) {
        this.auth = auth;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.pullRequests = { openByRepo: {}, closedByRepo: {}, wipByRepo: {} };
        this.mode = 'all';
        this.lastQuery = '';
        this._loading = false;
    }

    refresh(): void {
        invalidateWorkspaceCache();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: any): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: any): Promise<any[]> {
        if (!this.auth.isConfigured()) return [];
        try {
            if (!element) {
                if (this.mode === 'search') return this.pullRequests;

                if (this._loading) return [];
                this._loading = true;

                try {
                    const repos = await this.auth.makeRequest('/api/v1/user/repos');
                    const allRepos: GiteaRepository[] = repos || [];
                    let workspaceRepos = filterRepositoriesByWorkspace(allRepos);

                    if (workspaceRepos.length === 0) {
                        if (shouldShowAllReposWhenNoWorkspace()) {
                            workspaceRepos = allRepos;
                        } else {
                            const action = await promptForWorkspaceRepos(allRepos);
                            if (action === 'showAll') workspaceRepos = allRepos;
                        }
                    }

                    const repoResults = await Promise.all(workspaceRepos.map(async repo => {
                        try {
                            const [openPRs, closedPRs] = await Promise.all([
                                this.auth.makeRequest(
                                    `/api/v1/repos/${repo.owner!.login}/${repo.name}/pulls?state=open&limit=50`
                                ),
                                this.auth.makeRequest(
                                    `/api/v1/repos/${repo.owner!.login}/${repo.name}/pulls?state=closed&limit=50`
                                )
                            ]);
                            return {
                                repo,
                                open: Array.isArray(openPRs) ? openPRs : [],
                                closed: Array.isArray(closedPRs) ? closedPRs : []
                            };
                        } catch (err) {
                            console.error(`Failed to fetch PRs for ${repo.full_name}:`, err);
                            return { repo, open: [], closed: [] };
                        }
                    }));

                    const openByRepo: any = {};
                    const closedByRepo: any = {};
                    const wipByRepo: any = {};

                    for (const { repo, open, closed } of repoResults) {
                        const openItems: PullRequestTreeItem[] = [];
                        const wipItems: PullRequestTreeItem[] = [];
                        open.forEach((pr: GiteaPullRequest) => {
                            const isWIP = pr.draft || /^(wip|\[wip\]|work in progress|draft)/i.test(pr.title);
                            if (isWIP) wipItems.push(new PullRequestTreeItem(pr, repo.full_name));
                            else openItems.push(new PullRequestTreeItem(pr, repo.full_name));
                        });
                        const closedItems = closed.map((pr: GiteaPullRequest) => new PullRequestTreeItem(pr, repo.full_name));

                        if (openItems.length > 0) openByRepo[repo.full_name] = openItems;
                        if (wipItems.length > 0) wipByRepo[repo.full_name] = wipItems;
                        if (closedItems.length > 0) closedByRepo[repo.full_name] = closedItems;
                    }

                    this.pullRequests = { openByRepo, closedByRepo, wipByRepo };
                    this.mode = 'all';

                    const repoNames = new Set([
                        ...Object.keys(openByRepo),
                        ...Object.keys(wipByRepo),
                        ...Object.keys(closedByRepo)
                    ]);
                    return Array.from(repoNames).map(repoName => {
                        const total = (openByRepo[repoName]?.length || 0) +
                            (wipByRepo[repoName]?.length || 0) +
                            (closedByRepo[repoName]?.length || 0);
                        const repoGroup = new vscode.TreeItem(`${repoName} (${total})`, vscode.TreeItemCollapsibleState.Collapsed);
                        repoGroup.contextValue = 'prRepoGroup';
                        repoGroup.iconPath = new vscode.ThemeIcon('repo');
                        repoGroup.id = `repo:${repoName}`;
                        return repoGroup;
                    });
                } finally {
                    this._loading = false;
                }
            }

            if (element.contextValue === 'prRepoGroup') {
                const repoName = element.id.substring('repo:'.length);
                const openCount = this.pullRequests.openByRepo[repoName]?.length || 0;
                const wipCount = this.pullRequests.wipByRepo[repoName]?.length || 0;
                const closedCount = this.pullRequests.closedByRepo[repoName]?.length || 0;
                const openGroup = new vscode.TreeItem(`Open (${openCount})`, vscode.TreeItemCollapsibleState.Expanded);
                openGroup.contextValue = 'prStateGroup';
                openGroup.iconPath = new vscode.ThemeIcon('git-pull-request');
                openGroup.id = `repo:${repoName}:open`;
                const wipGroup = new vscode.TreeItem(`Work-in-Progress (${wipCount})`, vscode.TreeItemCollapsibleState.Collapsed);
                wipGroup.contextValue = 'prStateGroup';
                wipGroup.iconPath = new vscode.ThemeIcon('git-pull-request-draft');
                wipGroup.id = `repo:${repoName}:wip`;
                const closedGroup = new vscode.TreeItem(`Closed (${closedCount})`, vscode.TreeItemCollapsibleState.Collapsed);
                closedGroup.contextValue = 'prStateGroup';
                closedGroup.iconPath = new vscode.ThemeIcon('git-pull-request-closed');
                closedGroup.id = `repo:${repoName}:closed`;
                return [openGroup, wipGroup, closedGroup];
            }

            if (element.contextValue === 'prStateGroup') {
                const parts = element.id.split(':');
                if (parts.length < 3) return [];
                const repoName = parts[1];
                const state = parts[2];
                let repoMap;
                if (state === 'open') repoMap = this.pullRequests.openByRepo;
                else if (state === 'wip') repoMap = this.pullRequests.wipByRepo;
                else repoMap = this.pullRequests.closedByRepo;
                return repoMap[repoName] || [];
            }
        } catch (error: any) {
            this._loading = false;
            vscode.window.showErrorMessage(`Failed to load pull requests: ${error.message}`);
        }
        return [];
    }

    async searchPullRequests(query: string): Promise<void> {
        try {
            const repos = await this.auth.makeRequest('/api/v1/user/repos');
            const allRepos: GiteaRepository[] = repos || [];
            let workspaceRepos = filterRepositoriesByWorkspace(allRepos);

            if (workspaceRepos.length === 0) {
                if (shouldShowAllReposWhenNoWorkspace()) {
                    workspaceRepos = allRepos;
                } else {
                    const action = await promptForWorkspaceRepos(allRepos);
                    if (action === 'showAll') workspaceRepos = allRepos;
                }
            }

            const allPRs: PullRequestTreeItem[] = [];
            await Promise.all(workspaceRepos.map(async repo => {
                try {
                    const prs = await this.auth.makeRequest(
                        `/api/v1/repos/${repo.owner!.login}/${repo.name}/pulls?q=${encodeURIComponent(query)}&state=all&limit=50`
                    );
                    if (Array.isArray(prs)) {
                        prs.forEach((pr: GiteaPullRequest) => {
                            if (pr.title.toLowerCase().includes(query.toLowerCase())) {
                                allPRs.push(new PullRequestTreeItem(pr, repo.full_name));
                            }
                        });
                    }
                } catch (err) { console.error(`Failed to search PRs in ${repo.full_name}:`, err); }
            }));

            this.pullRequests = allPRs;
            this.mode = 'search';
            this.lastQuery = query;
            this.refresh();
        } catch (error: any) { vscode.window.showErrorMessage(`Failed to search pull requests: ${error.message}`); }
    }

    resetSearch(): void { this.mode = 'all'; this.lastQuery = ''; this.pullRequests = { openByRepo: {}, closedByRepo: {}, wipByRepo: {} }; }
}
