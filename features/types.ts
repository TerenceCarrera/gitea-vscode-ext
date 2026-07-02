import * as vscode from 'vscode';

export interface GiteaProfile {
    instanceUrl: string;
    authToken: string;
    userName?: string;
    userEmail?: string;
}

export interface GiteaProfiles {
    [name: string]: GiteaProfile;
}

export interface ProfileInfo {
    name: string;
    url: string;
    isActive: boolean;
}

export interface GiteaRepository {
    id: number;
    name: string;
    full_name: string;
    owner?: { login: string };
    description?: string;
    private?: boolean;
    html_url: string;
    clone_url: string;
    [key: string]: unknown;
}

export interface GiteaIssue {
    number: number;
    title: string;
    state: string;
    body?: string;
    html_url: string;
    user?: { login: string };
    assignees?: Array<{ login: string }>;
    labels?: Array<{ id: number; name: string; color: string }>;
    milestone?: { title: string; due_on?: string };
    created_at: string;
    updated_at: string;
    pull_request?: unknown;
    [key: string]: unknown;
}

export interface GiteaPullRequest {
    number: number;
    title: string;
    state: string;
    body?: string;
    html_url: string;
    user?: { login: string };
    assignees?: Array<{ login: string }>;
    labels?: Array<{ id: number; name: string; color: string }>;
    milestone?: { title: string; due_on?: string };
    head?: { ref: string; sha?: string };
    base?: { ref: string; sha?: string };
    draft?: boolean;
    merged?: boolean;
    mergeable?: boolean;
    created_at: string;
    updated_at: string;
    merged_at?: string;
    closed_at?: string;
    commits?: number;
    changed_files?: number;
    additions?: number;
    deletions?: number;
    requested_reviewers?: Array<{ login: string }>;
    [key: string]: unknown;
}

export interface GiteaComment {
    id: number;
    body: string;
    html_url: string;
    user?: { login: string };
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

export interface GiteaReview {
    id: number;
    body?: string;
    state?: string;
    user?: { login: string };
    submitted_at: string;
    [key: string]: unknown;
}

export interface GiteaCommit {
    sha: string;
    commit?: {
        message: string;
        author?: { name: string; date: string };
    };
    author?: { login: string };
    html_url?: string;
    url?: string;
    created_at?: string;
    [key: string]: unknown;
}

export interface GiteaFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
    previous_filename?: string;
    [key: string]: unknown;
}

export interface DeletedBranchInfo {
    name: string;
    commit: string;
    deletedAt: string;
    deletedBy: string;
}

export interface ImportedIssue {
    title: string;
    body: string;
    labels: string[];
    assignee: string;
    milestone: string;
    state: string;
    priority: string;
    dueDate: string;
}

export interface ImportResults {
    successful: Array<{ title: string; number: number; url: string; state: string }>;
    failed: Array<{ title: string; error: string }>;
    skipped: number;
    duplicates: Array<{ title: string; potentialMatches: DuplicateMatch[] }>;
    duplicateDetectionFailed: boolean;
}

export interface DuplicateMatch {
    number: number;
    title: string;
    state: string;
    url: string;
    similarity: number;
    created_at: string;
    updated_at: string;
}

export interface ImportOptions {
    allowAssignee: boolean;
    allowMilestone: boolean;
    allowDueDate: boolean;
    checkDuplicates: boolean;
    duplicateThreshold: number;
}

export interface CommandDeps {
    repositoryProvider: any;
    issueProvider: any;
    pullRequestProvider: any;
    prWebviewProvider: any;
    issueWebviewProvider: any;
    prCreationProvider: any;
    versionInfoProvider: any;
    branchManager: any;
    deletedBranchesProvider: any;
    stashManager: any;
    giteaStatusBar: vscode.StatusBarItem;
    throttledRefresh: () => void;
    getNotificationManager: () => any;
    getShowAllReposWhenNoWorkspace: () => boolean;
    promptNoWorkspaceRepos: (allRepos: GiteaRepository[]) => Promise<string | null>;
}

export interface StashInfo {
    id: string;
    description: string;
}

export interface NotificationStatus {
    isMonitoring: boolean;
    pollInterval: number;
}
