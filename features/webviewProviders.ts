import * as vscode from 'vscode';
import { marked } from 'marked';
import * as https from 'https';
import * as http from 'http';
import GiteaAuth from './auth';
import { GiteaFile, GiteaRepository } from './types';

marked.use({
    renderer: {
        html(token: any) {
            const text = typeof token === 'string' ? token : (token.text || '');
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }
    }
});

export async function embedGiteaImages(auth: GiteaAuth, html: string): Promise<string> {
    if (!auth.instanceUrl || !auth.authToken) return html;

    const baseUrl = auth.instanceUrl.replace(/\/$/, '');
    const imgSrcRegex = /<img([^>]*?)\ssrc="(https?:\/\/[^"]+)"([^>]*?)>/gi;
    const urlsToFetch = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = imgSrcRegex.exec(html)) !== null) {
        const src = m[2];
        if (src.startsWith(baseUrl + '/') || src.startsWith(baseUrl + '?')) {
            urlsToFetch.add(src);
        }
    }
    if (urlsToFetch.size === 0) return html;

    const dataUriMap = new Map<string, string>();
    await Promise.all([...urlsToFetch].map(async (src) => {
        try {
            const parsedUrl = new URL(src);
            const protocol = parsedUrl.protocol === 'https:' ? https : http;
            const buffer = await new Promise<Buffer>((resolve, reject) => {
                const req = protocol.request(
                    parsedUrl,
                    { method: 'GET', headers: { 'Authorization': `token ${auth.authToken}` } },
                    (res) => {
                        const chunks: Buffer[] = [];
                        res.on('data', (chunk: Buffer) => chunks.push(chunk));
                        res.on('end', () => {
                            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                                resolve(Buffer.concat(chunks));
                            } else {
                                reject(new Error(`HTTP ${res.statusCode}`));
                            }
                        });
                    }
                );
                req.on('error', reject);
                req.end();
            });
            const contentType = 'image/png';
            dataUriMap.set(src, `data:${contentType};base64,${buffer.toString('base64')}`);
        } catch (err: any) {
            console.error(`embedGiteaImages: failed to fetch ${src}:`, err.message);
        }
    }));

    return html.replace(imgSrcRegex, (full, before, src, after) => {
        const dataUri = dataUriMap.get(src);
        return dataUri ? `<img${before} src="${dataUri}"${after}>` : full;
    });
}

class PullRequestWebviewProvider {
    private auth: GiteaAuth;
    private _panels: Map<string, vscode.WebviewPanel>;

    constructor(auth: GiteaAuth) {
        this.auth = auth;
        this._panels = new Map();
    }

    async showPullRequest(prNumber: number, repository: string): Promise<void> {
        try {
            const panelKey = `${repository}#${prNumber}`;

            if (this._panels.has(panelKey)) {
                const panel = this._panels.get(panelKey)!;
                panel.reveal(vscode.ViewColumn.One);
                return;
            }

            const [owner, repo] = repository.split('/');
            let prDetails: any, comments: any[], reviews: any[], files: any[], commitsList: any[], diffContent: string | undefined, conflictingFiles: any[] = [], compareInfo: any = null;

            try {
                [prDetails, comments, reviews, files, commitsList] = await Promise.all([
                    this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}`),
                    this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/${prNumber}/comments`),
                    this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}/reviews`).catch(() => []),
                    this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}/files`).catch(() => []),
                    this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}/commits`).catch(() => [])
                ]);

                try {
                    const baseRef = encodeURIComponent(prDetails.base?.ref || '');
                    const headRef = encodeURIComponent(prDetails.head?.ref || '');
                    if (baseRef && headRef) {
                        compareInfo = await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/compare/${baseRef}...${headRef}`)
                            .catch(() => null);
                    }
                } catch (e) {
                    void (e);
                    compareInfo = null;
                }

                if (prDetails.mergeable === false && files && files.length > 0) {
                    conflictingFiles = files.filter((file: any) => {
                        if (file.status === 'conflicted') {
                            return true;
                        }

                        if (file.patch) {
                            const hasConflictStart = /^<{7} /m.test(file.patch);
                            const hasConflictSeparator = /^={7}$/m.test(file.patch);
                            const hasConflictEnd = /^>{7} /m.test(file.patch);

                            return hasConflictStart && hasConflictSeparator && hasConflictEnd;
                        }

                        return false;
                    });
                }

                prDetails.commits = typeof prDetails.commits === 'number'
                    ? prDetails.commits
                    : (Array.isArray(commitsList) ? commitsList.length : 0);

                try {
                    diffContent = await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}.diff`, {
                        headers: { 'Accept': 'text/plain' }
                    });

                    if (typeof diffContent === 'string') {
                        files = this.parseDiffToFiles(files, diffContent);
                    }
                } catch (diffError: any) {
                    console.error('Failed to fetch diff:', diffError);
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to load PR #${prNumber}: ${error.message}`);
                return;
            }

            const panel = vscode.window.createWebviewPanel(
                'giteaPullRequest',
                `PR #${prNumber}: ${prDetails.title}`,
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            this._panels.set(panelKey, panel);

            panel.onDidDispose(() => {
                this._panels.delete(panelKey);
            });

            panel.webview.onDidReceiveMessage(
                async (message: any) => {
                    try {
                        switch (message.command) {
                            case 'addComment':
                                await this.addComment(owner, repo, prNumber, message.body);
                                break;
                            case 'addReview':
                                await this.addReview(owner, repo, prNumber, message.body, message.event);
                                break;
                            case 'mergePR':
                                await this.mergePullRequest(owner, repo, prNumber, message.mergeMethod);
                                break;
                            case 'closePR':
                                await this.closePullRequest(owner, repo, prNumber);
                                break;
                            case 'createBranch':
                                vscode.commands.executeCommand('gitea.createBranchFromPR', {
                                    metadata: { repository: `${owner}/${repo}`, number: prNumber }
                                });
                                break;
                            case 'openInBrowser':
                                vscode.env.openExternal(vscode.Uri.parse(prDetails.html_url));
                                break;
                            case 'updateBranch':
                                await this.updatePullRequestBranch(owner, repo, prNumber, message.style || 'merge');
                                break;
                        }
                    } catch (error: any) {
                        console.error('Error handling webview message:', error);
                        vscode.window.showErrorMessage(`Error: ${error.message}`);
                    }
                }
            );

            panel.webview.html = await embedGiteaImages(this.auth, this.getPullRequestHtml(panel.webview, prDetails, comments, reviews, files, commitsList, conflictingFiles, compareInfo));
        } catch (error: any) {
            console.error('Failed to show pull request:', error);
            vscode.window.showErrorMessage(`Failed to show pull request: ${error.message}`);
        }
    }

    async addComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
        try {
            await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
                method: 'POST',
                body: { body }
            });
            vscode.window.showInformationMessage('Comment added successfully');
            await this.showPullRequest(prNumber, `${owner}/${repo}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to add comment: ${error.message}`);
        }
    }

    async addReview(owner: string, repo: string, prNumber: number, body: string, event: string): Promise<void> {
        try {
            await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
                method: 'POST',
                body: { body, event }
            });
            vscode.window.showInformationMessage(`Review ${event.toLowerCase()} successfully`);
            await this.showPullRequest(prNumber, `${owner}/${repo}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to submit review: ${error.message}`);
        }
    }

    async mergePullRequest(owner: string, repo: string, prNumber: number, mergeMethod: string = 'merge'): Promise<void> {
        try {
            await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
                method: 'POST',
                body: { Do: mergeMethod }
            });
            vscode.window.showInformationMessage(`PR #${prNumber} merged successfully`);
            await this.showPullRequest(prNumber, `${owner}/${repo}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to merge PR: ${error.message}`);
        }
    }

    async closePullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
        try {
            await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}`, {
                method: 'PATCH',
                body: { state: 'closed' }
            });
            vscode.window.showInformationMessage(`PR #${prNumber} closed`);
            await this.showPullRequest(prNumber, `${owner}/${repo}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to close PR: ${error.message}`);
        }
    }

    async updatePullRequestBranch(owner: string, repo: string, prNumber: number, style: string = 'merge'): Promise<void> {
        try {
            try {
                await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}/update`, {
                    method: 'POST',
                    body: { style }
                });
            } catch (firstErr: any) {
                void (firstErr);
                await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}/update`, {
                    method: 'POST',
                    body: { Style: style }
                });
            }

            vscode.window.showInformationMessage('Branch updated from base via merge');
            await this.showPullRequest(prNumber, `${owner}/${repo}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to update branch: ${error.message}`);
        }
    }

    getPullRequestHtml(webview: vscode.Webview, pr: any, comments: any[], reviews: any[], files: any[] = [], commits: any[] = [], conflictingFiles: any[] = [], compareInfo: any = null): string {
        const stateOpen = pr.state === 'open';
        const stateMerged = !!pr.merged;
        const stateText = stateOpen ? 'Open' : stateMerged ? 'Merged' : 'Closed';
        const behindCount = compareInfo
            ? (Number(compareInfo.behind_by) || Number(compareInfo.behind) || Number(compareInfo.behindBy) || 0)
            : 0;
        const isOutOfDate = behindCount > 0;

        const commentsHtml = (comments && comments.length > 0)
            ? comments.map((c: any) => {
                const av = (c.user?.login || '?')[0].toUpperCase();
                const edited = c.updated_at && c.updated_at !== c.created_at
                    ? ' <span style="color:var(--fg2);font-weight:400">(edited)</span>' : '';
                return `
<div class="gh-tl-item" id="cmt-${c.id}">
  <div class="avatar">${av}</div>
  <div class="comment-box">
    <div class="comment-header">
      <span class="ch-author">${this.escapeHtml(c.user?.login || 'Unknown')}</span>
      <span class="ch-meta">${new Date(c.created_at).toLocaleString()}${edited}</span>
    </div>
    <div class="comment-body md">${this.renderMarkdown(c.body || '')}</div>
  </div>
</div>`;
            }).join('')
            : '';

        const commitsHtml = (commits && commits.length > 0)
            ? commits.map((c: any) => {
                const sha = c.sha?.substring(0, 7) || 'unknown';
                const msg = this.escapeHtml(c.commit?.message || c.message || 'No message');
                const author = this.escapeHtml(c.commit?.author?.name || c.author?.login || 'Unknown');
                const date = new Date(c.commit?.author?.date || c.created_at).toLocaleString();
                return `<div class="commit-row"><div class="commit-msg">${msg}</div><div class="commit-meta">${author} · <span class="commit-sha">${sha}</span> · ${date}</div></div>`;
            }).join('')
            : '<p style="color:var(--fg2)">No commits.</p>';

        const filesHtml = (files && files.length > 0)
            ? files.map((file: any, i: number) => {
                const status = this.getFileStatus(file);
                const icon = this.getFileIcon(status);
                return `
<div class="file-item">
  <div class="file-hdr" onclick="toggleFile(${i})">
    <span style="margin-right:8px">${icon}</span>
    <span class="file-name">${this.escapeHtml(file.filename)}</span>
    <span class="file-stats"><span class="add">+${file.additions || 0}</span> <span class="del">-${file.deletions || 0}</span></span>
  </div>
  <div class="file-diff" id="fdiff-${i}" style="display:none">${file.patch ? this.renderDiff(file.patch) : '<span style="color:var(--fg2);padding:8px;display:block">No diff available</span>'}</div>
</div>`;
            }).join('')
            : '<p style="color:var(--fg2)">No files changed.</p>';

        const reviewsHtml = (reviews && reviews.length > 0)
            ? reviews.map((r: any) => {
                const state = r.state || 'COMMENTED';
                const cls = state === 'APPROVED' ? 'rv-approved' : state === 'REQUEST_CHANGES' ? 'rv-changes' : '';
                const lbl = state === 'APPROVED' ? '✓ Approved' : state === 'REQUEST_CHANGES' ? '✗ Changes requested' : 'Commented';
                const av = (r.user?.login || '?')[0].toUpperCase();
                return `
<div class="gh-tl-item">
  <div class="avatar">${av}</div>
  <div class="comment-box ${cls}">
    <div class="comment-header">
      <span class="ch-author">${this.escapeHtml(r.user?.login || 'Unknown')}</span>
      <span class="ch-meta">${lbl} · ${new Date(r.submitted_at).toLocaleString()}</span>
    </div>
    ${r.body ? `<div class="comment-body md">${this.renderMarkdown(r.body)}</div>` : ''}
  </div>
</div>`;
            }).join('')
            : '';

        const labelsHtml = (pr.labels && pr.labels.length > 0)
            ? pr.labels.map((l: any) => `<span class="label-pill" style="background:#${this.escapeHtml(l.color)};color:${this.getContrastColor(l.color)}">${this.escapeHtml(l.name)}</span>`).join('')
            : '<span style="color:var(--fg2);font-size:12px">None yet</span>';

        const reviewersHtml = (pr.requested_reviewers && pr.requested_reviewers.length > 0)
            ? pr.requested_reviewers.map((r: any) => `<div class="sb-item">${this.escapeHtml(r.login)}</div>`).join('')
            : '<span style="color:var(--fg2);font-size:12px">None</span>';

        const assigneesHtml = (pr.assignees && pr.assignees.length > 0)
            ? pr.assignees.map((a: any) => `<div class="sb-item">${this.escapeHtml(a.login)}</div>`).join('')
            : '<span style="color:var(--fg2);font-size:12px">None</span>';

        const svgOpen = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.177 3.073L9.573.677A.25.25 0 0 1 10 .854v4.792a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354z"/><path fill-rule="evenodd" d="M3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25z"/></svg>`;
        const svgMerged = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372A2.25 2.25 0 1 1 5.45 5.154zM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5zM5 3.25a.75.75 0 1 0 0 .005V3.25z"/></svg>`;
        const svgClosed = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25zm7-2.25a.75.75 0 0 1 .75.75v6.586l1.22-1.22a.75.75 0 1 1 1.06 1.06l-2.5 2.5a.75.75 0 0 1-1.06 0l-2.5-2.5a.75.75 0 0 1 1.06-1.06l1.22 1.22V1.25a.75.75 0 0 1 .75-.75z"/></svg>`;

        const mergeBoxHtml = stateOpen
            ? (pr.mergeable ? `
<div class="merge-box merge-ok">
  <div class="merge-box-hdr"><span class="merge-icon">✓</span><span>This branch has no conflicts with the base branch</span></div>
  <div class="merge-actions">
    <select id="mergeMethod" class="merge-select">
      <option value="merge">Create a merge commit</option>
      <option value="squash">Squash and merge</option>
      <option value="rebase">Rebase and merge</option>
    </select>
    <button class="btn btn-success" onclick="mergePR()">Merge pull request</button>
    <button class="btn btn-danger" onclick="closePR()">Close PR</button>
  </div>
</div>` : `
<div class="merge-box merge-conflict">
  <div class="merge-box-hdr"><span class="merge-icon">✗</span><span>This branch has conflicts that must be resolved</span></div>
  ${conflictingFiles.length > 0
        ? `<ul class="conflict-files">${conflictingFiles.map((f: any) => `<li>${this.escapeHtml(f.filename)}</li>`).join('')}</ul>`
        : '<p style="color:var(--fg2);font-size:13px;margin:8px 0 0">Conflicts detected. Check the PR on your server for exact paths.</p>'}
  <div class="merge-actions" style="margin-top:12px">
    <button class="btn btn-danger" onclick="closePR()">Close PR</button>
  </div>
</div>`)
            : (stateMerged ? `
<div class="merge-box merge-merged">
  <div class="merge-box-hdr"><span class="merge-icon">✓</span><span>Pull request successfully merged and closed</span></div>
</div>` : `
<div class="merge-box merge-closed">
  <div class="merge-box-hdr"><span class="merge-icon">✗</span><span>This pull request is closed</span></div>
  <div class="merge-actions" style="margin-top:12px"><button class="btn btn-success" onclick="reopenPR()">Reopen PR</button></div>
</div>`);

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root {
  --open:#2da44e;--merged:#8957e5;--closed:#cf222e;
  --bd:var(--vscode-panel-border);--bg:var(--vscode-editor-background);--fg:var(--vscode-foreground);--fg2:var(--vscode-descriptionForeground);
  --inp-bg:var(--vscode-input-background);--inp-fg:var(--vscode-input-foreground);--inp-bd:var(--vscode-input-border,var(--bd));
  --hdr-bg:var(--vscode-sideBarSectionHeader-background,rgba(128,128,128,.08));
  --btn-bg:var(--vscode-button-background);--btn-fg:var(--vscode-button-foreground);--btn-hov:var(--vscode-button-hoverBackground);
  --btn2-bg:var(--vscode-button-secondaryBackground);--btn2-fg:var(--vscode-button-secondaryForeground);
  --link:var(--vscode-textLink-foreground);--code-bg:var(--vscode-textCodeBlock-background);--av-size:32px;
}
*{box-sizing:border-box}
body{font-family:var(--vscode-font-family);font-size:14px;color:var(--fg);background:var(--bg);margin:0;padding:16px 20px}
.gh-header{padding-bottom:12px;border-bottom:1px solid var(--bd);margin-bottom:12px}
.gh-title{font-size:20px;font-weight:600;margin:0 0 6px;line-height:1.3}
.gh-title-num{color:var(--fg2);font-weight:400}
.gh-meta{font-size:13px;color:var(--fg2);display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:500;white-space:nowrap}
.badge-open{background:var(--open);color:#fff}
.badge-merged{background:var(--merged);color:#fff}
.badge-closed{background:var(--closed);color:#fff}
.badge-draft{background:#6e7681;color:#fff}
.stats-row{display:flex;gap:16px;font-size:13px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--bd);margin-bottom:12px}
.stat-item{display:flex;align-items:center;gap:4px;color:var(--fg2)}
.stat-item b{color:var(--fg)}
.ood-banner{display:flex;gap:12px;padding:12px;background:rgba(210,153,34,.08);border:1px solid var(--bd);border-left:3px solid #d29922;border-radius:6px;margin-bottom:12px;font-size:13px}
.ood-icon{color:#d29922;font-size:16px;flex-shrink:0}
.tabs{display:flex;border-bottom:1px solid var(--bd);margin-bottom:16px}
.tab{padding:8px 16px;font-size:13px;cursor:pointer;border:none;background:none;color:var(--fg2);border-bottom:2px solid transparent;margin-bottom:-1px;font-family:inherit}
.tab:hover{color:var(--fg)}
.tab.active{color:var(--fg);border-bottom-color:var(--link);font-weight:500}
.tab-panel{display:none}
.tab-panel.active{display:block}
.gh-layout{display:flex;gap:20px;align-items:flex-start}
.gh-main{flex:1;min-width:0}
.gh-sidebar{width:210px;flex-shrink:0}
.gh-tl{position:relative}
.gh-tl-item{display:flex;gap:12px;position:relative;margin-bottom:16px}
.gh-tl-item::before{content:'';position:absolute;left:calc(var(--av-size)/2 - 1px);top:var(--av-size);bottom:-16px;width:2px;background:var(--bd)}
.gh-tl-item:last-child::before{display:none}
.avatar{width:var(--av-size);height:var(--av-size);border-radius:50%;background:var(--btn-bg);color:var(--btn-fg);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0}
.comment-box{flex:1;min-width:0;border:1px solid var(--bd);border-radius:6px;overflow:hidden}
.comment-header{display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:var(--hdr-bg);border-bottom:1px solid var(--bd);font-size:12px;flex-wrap:wrap;gap:4px}
.ch-author{font-weight:600;color:var(--fg)}
.ch-meta{color:var(--fg2)}
.comment-body{padding:12px;line-height:1.6}
.rv-approved .comment-header{background:rgba(45,164,78,.08);border-color:rgba(45,164,78,.3)}
.rv-changes .comment-header{background:rgba(248,81,73,.08);border-color:rgba(248,81,73,.3)}
.merge-box{border:1px solid var(--bd);border-radius:6px;padding:14px;margin:8px 0 16px}
.merge-box-hdr{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:500}
.merge-icon{font-size:18px;width:24px;text-align:center}
.merge-ok .merge-icon{color:var(--open)}
.merge-conflict .merge-icon{color:#f85149}
.merge-merged .merge-icon{color:var(--merged)}
.merge-closed .merge-icon{color:var(--closed)}
.merge-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center}
.merge-select{background:var(--inp-bg);color:var(--inp-fg);border:1px solid var(--inp-bd);border-radius:6px;padding:5px 8px;font-size:13px;font-family:inherit}
.conflict-files{margin:8px 0 0;padding-left:20px;color:var(--fg2);font-size:12px;font-family:var(--vscode-editor-font-family)}
.review-section{border:1px solid var(--bd);border-radius:6px;overflow:hidden;margin-bottom:16px}
.review-section-hdr{padding:8px 12px;background:var(--hdr-bg);border-bottom:1px solid var(--bd);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--fg2)}
.review-section-body{padding:12px}
.review-btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.new-box textarea{width:100%;min-height:80px;background:var(--inp-bg);color:var(--inp-fg);border:1px solid var(--inp-bd);border-radius:6px;padding:8px;font-family:inherit;font-size:13px;resize:vertical}
.new-box-actions{display:flex;justify-content:flex-end;margin-top:8px;gap:8px}
.commit-row{border:1px solid var(--bd);border-radius:6px;padding:10px 12px;margin-bottom:8px}
.commit-msg{font-size:13px;font-weight:500;word-break:break-word;margin-bottom:4px}
.commit-meta{font-size:12px;color:var(--fg2)}
.commit-sha{font-family:var(--vscode-editor-font-family);background:var(--code-bg);padding:1px 5px;border-radius:4px;font-size:11px}
.file-item{border:1px solid var(--bd);border-radius:6px;margin-bottom:8px;overflow:hidden}
.file-hdr{display:flex;align-items:center;padding:8px 12px;background:var(--hdr-bg);cursor:pointer;font-size:13px}
.file-hdr:hover{background:var(--vscode-list-hoverBackground)}
.file-name{flex:1;font-family:var(--vscode-editor-font-family);font-size:12px}
.file-stats{display:flex;gap:8px;font-size:12px;font-family:var(--vscode-editor-font-family)}
.add{color:#3fb950}.del{color:#f85149}
.file-diff{background:var(--code-bg);padding:8px;font-family:var(--vscode-editor-font-family);font-size:12px;line-height:1.5;overflow-x:auto}
.diff-line{display:block;white-space:pre;padding:0 6px}
.diff-line.addition{background:rgba(63,185,80,.15)}
.diff-line.deletion{background:rgba(248,81,73,.15)}
.diff-line.context{color:var(--fg2)}
.diff-line.header{color:var(--link);font-weight:600}
.sb-section{border:1px solid var(--bd);border-radius:6px;overflow:hidden;margin-bottom:10px}
.sb-heading{padding:6px 10px;background:var(--hdr-bg);border-bottom:1px solid var(--bd);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--fg2)}
.sb-body{padding:8px 10px;font-size:13px}
.sb-item{margin-bottom:4px}
.sb-item:last-child{margin-bottom:0}
.label-pill{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:500;margin:2px 2px 2px 0}
.btn{display:inline-flex;align-items:center;padding:5px 14px;border-radius:6px;border:none;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit}
.btn-primary{background:var(--btn-bg);color:var(--btn-fg)}.btn-primary:hover{background:var(--btn-hov)}
.btn-secondary{background:var(--btn2-bg);color:var(--btn2-fg)}
.btn-success{background:#2da44e;color:#fff}.btn-success:hover{background:#2c974b}
.btn-danger{background:#f85149;color:#fff}.btn-danger:hover{background:#da3633}
.md{line-height:1.7}
.md>*:first-child{margin-top:0!important}.md>*:last-child{margin-bottom:0!important}
.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{font-weight:600;line-height:1.3;margin:16px 0 8px}
.md h1{font-size:1.6em;border-bottom:1px solid var(--bd);padding-bottom:.3em}
.md h2{font-size:1.3em;border-bottom:1px solid var(--bd);padding-bottom:.3em}
.md h3{font-size:1.1em}
.md p{margin:0 0 12px}
.md code{background:var(--code-bg);padding:.2em .4em;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:.85em}
.md pre{background:var(--code-bg);padding:12px;border-radius:6px;overflow:auto;margin:12px 0}
.md pre code{background:none;padding:0}
.md blockquote{border-left:3px solid var(--bd);padding-left:14px;color:var(--fg2);margin:12px 0}
.md ul,.md ol{padding-left:2em;margin:6px 0 12px}
.md a{color:var(--link);text-decoration:none}.md a:hover{text-decoration:underline}
.md img{max-width:100%}
.md table{border-collapse:collapse;margin:12px 0;font-size:13px;width:100%}
.md th,.md td{border:1px solid var(--bd);padding:6px 12px}
.md th{background:var(--hdr-bg)}
</style>
</head>
<body>
<div class="gh-header">
  <h1 class="gh-title">${this.escapeHtml(pr.title)} <span class="gh-title-num">#${pr.number}</span></h1>
  <div class="gh-meta">
    <span class="badge ${stateOpen ? 'badge-open' : stateMerged ? 'badge-merged' : 'badge-closed'}">${stateOpen ? svgOpen : stateMerged ? svgMerged : svgClosed} ${stateText}</span>
    ${pr.draft ? '<span class="badge badge-draft">Draft</span>' : ''}
    <span><strong>${this.escapeHtml(pr.user?.login || 'Unknown')}</strong> wants to merge <strong>${this.escapeHtml(pr.head?.ref || 'unknown')}</strong> into <strong>${this.escapeHtml(pr.base?.ref || 'unknown')}</strong></span>
    <span>· ${new Date(pr.created_at).toLocaleString()}</span>
  </div>
</div>

<div class="stats-row">
  <div class="stat-item">Commits: <b>${pr.commits || commits.length || 0}</b></div>
  <div class="stat-item">Files changed: <b>${pr.changed_files || files.length || 0}</b></div>
  <div class="stat-item">Additions: <b style="color:#3fb950">+${pr.additions || 0}</b></div>
  <div class="stat-item">Deletions: <b style="color:#f85149">-${pr.deletions || 0}</b></div>
</div>

${isOutOfDate ? `
<div class="ood-banner">
  <div class="ood-icon">⚠</div>
  <div>
    <div style="font-weight:600;margin-bottom:4px">This branch is out-of-date with the base branch</div>
    <div style="color:var(--fg2);margin-bottom:8px">Behind by ${behindCount} commit${behindCount !== 1 ? 's' : ''}.</div>
    <button class="btn btn-secondary" onclick="updateBranch('merge')">Update branch</button>
  </div>
</div>` : ''}

<div class="tabs">
  <button class="tab active" onclick="switchTab('conversation',this)">Conversation <span style="background:var(--hdr-bg);border:1px solid var(--bd);border-radius:20px;padding:1px 7px;font-size:11px;margin-left:4px">${(comments?.length || 0) + (reviews?.length || 0)}</span></button>
  <button class="tab" onclick="switchTab('commits',this)">Commits <span style="background:var(--hdr-bg);border:1px solid var(--bd);border-radius:20px;padding:1px 7px;font-size:11px;margin-left:4px">${commits?.length || 0}</span></button>
  <button class="tab" onclick="switchTab('files',this)">Files changed <span style="background:var(--hdr-bg);border:1px solid var(--bd);border-radius:20px;padding:1px 7px;font-size:11px;margin-left:4px">${files?.length || 0}</span></button>
</div>

<div id="tab-conversation" class="tab-panel active">
  <div class="gh-layout">
    <div class="gh-main">
      <div class="gh-tl">
        ${pr.body ? `
        <div class="gh-tl-item">
          <div class="avatar">${(pr.user?.login || '?')[0].toUpperCase()}</div>
          <div class="comment-box">
            <div class="comment-header">
              <span class="ch-author">${this.escapeHtml(pr.user?.login || 'Unknown')}</span>
              <span class="ch-meta">opened this · ${new Date(pr.created_at).toLocaleString()}</span>
            </div>
            <div class="comment-body md">${this.renderMarkdown(pr.body)}</div>
          </div>
        </div>` : ''}
        ${reviewsHtml}
        ${commentsHtml}
      </div>
      ${mergeBoxHtml}
      ${stateOpen ? `
      <div class="review-section">
        <div class="review-section-hdr">Leave a review</div>
        <div class="review-section-body">
          <textarea id="reviewBody" placeholder="Leave a review comment (optional)..." style="width:100%;min-height:80px;background:var(--inp-bg);color:var(--inp-fg);border:1px solid var(--inp-bd);border-radius:6px;padding:8px;font-size:13px;font-family:inherit;resize:vertical"></textarea>
          <div class="review-btns">
            <button class="btn btn-success" onclick="submitReview('APPROVED')">✓ Approve</button>
            <button class="btn btn-secondary" onclick="submitReview('COMMENT')">Comment</button>
            <button class="btn btn-danger" onclick="submitReview('REQUEST_CHANGES')">✗ Request changes</button>
          </div>
        </div>
      </div>` : ''}
      <div class="new-box" style="margin-top:16px">
        <textarea id="commentBody" placeholder="Leave a comment..."></textarea>
        <div class="new-box-actions">
          <button class="btn btn-secondary" onclick="createBranch()">Create branch</button>
          <button class="btn btn-secondary" onclick="openInBrowser()">Open in browser</button>
          <button class="btn btn-primary" onclick="addComment()">Comment</button>
        </div>
      </div>
    </div>
    <div class="gh-sidebar">
      <div class="sb-section">
        <div class="sb-heading">Reviewers</div>
        <div class="sb-body">${reviewersHtml}</div>
      </div>
      <div class="sb-section">
        <div class="sb-heading">Assignees</div>
        <div class="sb-body">${assigneesHtml}</div>
      </div>
      <div class="sb-section">
        <div class="sb-heading">Labels</div>
        <div class="sb-body">${labelsHtml}</div>
      </div>
      ${pr.milestone ? `
      <div class="sb-section">
        <div class="sb-heading">Milestone</div>
        <div class="sb-body">
          <div class="sb-item">${this.escapeHtml(pr.milestone.title)}</div>
          ${pr.milestone.due_on ? `<div class="sb-item" style="font-size:12px;color:var(--fg2)">Due ${new Date(pr.milestone.due_on).toLocaleDateString()}</div>` : ''}
        </div>
      </div>` : ''}
      <div class="sb-section">
        <div class="sb-heading">Activity</div>
        <div class="sb-body" style="font-size:12px">
          <div class="sb-item"><span style="color:var(--fg2)">Opened:</span> ${new Date(pr.created_at).toLocaleDateString()}</div>
          ${pr.updated_at ? `<div class="sb-item"><span style="color:var(--fg2)">Updated:</span> ${new Date(pr.updated_at).toLocaleDateString()}</div>` : ''}
          ${pr.merged_at ? `<div class="sb-item"><span style="color:var(--fg2)">Merged:</span> ${new Date(pr.merged_at).toLocaleDateString()}</div>` : ''}
          ${pr.closed_at && !pr.merged_at ? `<div class="sb-item"><span style="color:var(--fg2)">Closed:</span> ${new Date(pr.closed_at).toLocaleDateString()}</div>` : ''}
        </div>
      </div>
    </div>
  </div>
</div>

<div id="tab-commits" class="tab-panel">
  ${commitsHtml}
</div>

<div id="tab-files" class="tab-panel">
  ${filesHtml}
</div>

<script>
const vscode = acquireVsCodeApi();
function switchTab(id, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  btn.classList.add('active');
}
function addComment() {
  var body = document.getElementById('commentBody').value.trim();
  if (!body) return;
  vscode.postMessage({ command: 'addComment', body });
  document.getElementById('commentBody').value = '';
}
function submitReview(event) {
  var el = document.getElementById('reviewBody');
  var body = el ? el.value.trim() : '';
  vscode.postMessage({ command: 'addReview', body, event });
  if (el) el.value = '';
}
function mergePR() {
  var el = document.getElementById('mergeMethod');
  var method = el ? el.value : 'merge';
  dlg('Merge Pull Request', 'Are you sure you want to merge this pull request?', function() {
    vscode.postMessage({ command: 'mergePR', mergeMethod: method });
  });
}
function closePR() {
  dlg('Close Pull Request', 'Are you sure you want to close this pull request?', function() {
    vscode.postMessage({ command: 'closePR' });
  });
}
function reopenPR() { vscode.postMessage({ command: 'reopenPR' }); }
function createBranch() { vscode.postMessage({ command: 'createBranch' }); }
function updateBranch(style) { vscode.postMessage({ command: 'updateBranch', style }); }
function openInBrowser() { vscode.postMessage({ command: 'openInBrowser' }); }
function toggleFile(i) {
  var el = document.getElementById('fdiff-' + i);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
function dlg(title, msg, cb) {
  var ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999';
  var bx = document.createElement('div');
  bx.style.cssText = 'background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:20px;max-width:400px;width:90%;box-shadow:0 4px 16px rgba(0,0,0,.3)';
  var h = document.createElement('div'); h.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:10px'; h.textContent = title;
  var p = document.createElement('div'); p.style.cssText = 'font-size:13px;color:var(--fg2);margin-bottom:18px'; p.textContent = msg;
  var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
  var cn = document.createElement('button'); cn.textContent = 'Cancel';
  cn.style.cssText = 'background:var(--btn2-bg);color:var(--btn2-fg);border:none;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:13px';
  cn.onclick = function() { ov.remove(); };
  var ok = document.createElement('button'); ok.textContent = 'Confirm';
  ok.style.cssText = 'background:var(--btn-bg);color:var(--btn-fg);border:none;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:13px;font-weight:500';
  ok.onclick = function() { ov.remove(); cb(); };
  row.append(cn, ok); bx.append(h, p, row); ov.append(bx); document.body.append(ov);
}
</script>
</body>
</html>`;
    }

    escapeHtml(text: any): string {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    getContrastColor(hexColor: string): string {
        try {
            if (!hexColor) return '#000000';
            const hex = hexColor.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            if (isNaN(r) || isNaN(g) || isNaN(b)) return '#000000';
            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
            return brightness > 155 ? '#000000' : '#ffffff';
        } catch (error) {
            console.error('Failed to calculate contrast color:', error);
            return '#000000';
        }
    }

    renderMarkdown(text: string): string {
        if (!text) return '';
        try {
            return marked.parse(text) as string;
        } catch (error) {
            void (error);
            return this.escapeHtml(text);
        }
    }

    renderDiff(patch: string): string {
        if (!patch) return '';
        const lines = patch.split('\n');
        return lines.map(line => {
            let className = 'context';
            if (line.startsWith('+')) className = 'addition';
            else if (line.startsWith('-')) className = 'deletion';
            else if (line.startsWith('@@')) className = 'header';

            return `<span class="diff-line ${className}">${this.escapeHtml(line)}</span>`;
        }).join('');
    }

    getFileStatus(file: any): string {
        if (file.status) {
            return file.status;
        }

        if (file.previous_filename || file.old_name) {
            return 'renamed';
        }

        const additions = file.additions || 0;
        const deletions = file.deletions || 0;

        if (additions > 0 && deletions === 0) {
            return 'added';
        }

        if (additions === 0 && deletions > 0) {
            return 'deleted';
        }

        if (additions > 0 || deletions > 0) {
            return 'modified';
        }

        return 'modified';
    }

    getFileIcon(status: string): string {
        switch (status) {
            case 'added': return '✚';
            case 'modified': return '✎';
            case 'deleted': return '✖';
            case 'renamed': return '➜';
            default: return '✎';
        }
    }

    parseDiffToFiles(files: GiteaFile[], diffContent: string): GiteaFile[] {
        if (!diffContent || !files) return files;

        const fileDiffs: { [key: string]: string } = {};
        const diffBlocks = diffContent.split(/\ndiff --git /);

        for (let i = 0; i < diffBlocks.length; i++) {
            const block = diffBlocks[i];
            if (!block.trim()) continue;

            const fullBlock = i === 0 && !block.startsWith('a/') ? block : 'a/' + block;

            let filename: string | null = null;

            let fileMatch = fullBlock.match(/^a\/(.+?) b\/(.+?)$/m);
            if (fileMatch) {
                filename = fileMatch[2];
            } else {
                fileMatch = fullBlock.match(/^\+\+\+ b\/(.+?)$/m);
                if (fileMatch) {
                    filename = fileMatch[1];
                }
            }

            if (!filename) continue;

            const lines = fullBlock.split('\n');
            const diffStartIndex = lines.findIndex(line => line.startsWith('@@'));

            if (diffStartIndex !== -1) {
                const patchContent = lines.slice(diffStartIndex).join('\n');
                fileDiffs[filename] = patchContent;
            } else {
                const plusIndex = lines.findIndex(line => line.startsWith('+++'));
                if (plusIndex !== -1 && plusIndex < lines.length - 1) {
                    const patchContent = lines.slice(plusIndex + 1).join('\n');
                    if (patchContent.trim()) {
                        fileDiffs[filename] = patchContent;
                    }
                }
            }
        }

        return files.map(file => {
            const patch = fileDiffs[file.filename] || file.patch || '';
            return {
                ...file,
                patch: patch
            };
        });
    }
}

class IssueWebviewProvider {
    private auth: GiteaAuth;
    private _panels: Map<string, vscode.WebviewPanel>;

    constructor(auth: GiteaAuth) {
        this.auth = auth;
        this._panels = new Map();
    }

    async showIssue(issueNumber: number, repository: string): Promise<void> {
        try {
            const panelKey = `${repository}#${issueNumber}`;

            if (this._panels.has(panelKey)) {
                const panel = this._panels.get(panelKey)!;
                panel.reveal(vscode.ViewColumn.One);
                return;
            }

            const [owner, repo] = repository.split('/');
            let issueDetails: any, comments: any[], currentUser: any;

            try {
                [issueDetails, comments, currentUser] = await Promise.all([
                    this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/${issueNumber}`),
                    this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/${issueNumber}/comments`),
                    this.auth.makeRequest('/api/v1/user').catch(() => null)
                ]);
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to load Issue #${issueNumber}: ${error.message}`);
                return;
            }

            const panel = vscode.window.createWebviewPanel(
                'giteaIssue',
                `Issue #${issueNumber}: ${issueDetails.title}`,
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            this._panels.set(panelKey, panel);

            panel.onDidDispose(() => {
                this._panels.delete(panelKey);
            });

            panel.webview.onDidReceiveMessage(
                async (message: any) => {
                    try {
                        switch (message.command) {
                            case 'addComment':
                                await this.addComment(owner, repo, issueNumber, message.body, panel, currentUser);
                                break;
                            case 'editComment':
                                await this.editComment(owner, repo, issueNumber, message.commentId, message.body, panel, currentUser);
                                break;
                            case 'deleteComment':
                                await this.deleteComment(owner, repo, issueNumber, message.commentId, panel, currentUser);
                                break;
                            case 'refresh':
                                await this._refreshPanel(panel, owner, repo, issueNumber, currentUser);
                                break;
                            case 'closeIssue':
                                await this.closeIssue(owner, repo, issueNumber);
                                await this._refreshPanel(panel, owner, repo, issueNumber, currentUser);
                                break;
                            case 'reopenIssue':
                                await this.reopenIssue(owner, repo, issueNumber);
                                await this._refreshPanel(panel, owner, repo, issueNumber, currentUser);
                                break;
                            case 'createBranch':
                                vscode.commands.executeCommand('gitea.createBranchFromIssue', {
                                    metadata: { repository: `${owner}/${repo}`, number: issueNumber }
                                });
                                break;
                            case 'openInBrowser':
                                vscode.env.openExternal(vscode.Uri.parse(issueDetails.html_url));
                                break;
                        }
                    } catch (error: any) {
                        console.error('Error handling webview message:', error);
                        vscode.window.showErrorMessage(`Error: ${error.message}`);
                    }
                }
            );

            panel.webview.html = await embedGiteaImages(this.auth, this.getIssueHtml(panel.webview, issueDetails, comments, currentUser));
        } catch (error: any) {
            console.error('Failed to show issue:', error);
            vscode.window.showErrorMessage(`Failed to show issue: ${error.message}`);
        }
    }

    async addComment(owner: string, repo: string, issueNumber: number, body: string, panel: vscode.WebviewPanel, currentUser: any): Promise<void> {
        try {
            await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
                method: 'POST',
                body: { body }
            });
            vscode.window.showInformationMessage('Comment added successfully');
            await this._refreshPanel(panel, owner, repo, issueNumber, currentUser);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to add comment: ${error.message}`);
        }
    }

    async editComment(owner: string, repo: string, issueNumber: number, commentId: number, body: string, panel: vscode.WebviewPanel, currentUser: any): Promise<void> {
        try {
            await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/comments/${commentId}`, {
                method: 'PATCH',
                body: { body }
            });
            vscode.window.showInformationMessage('Comment updated');
            await this._refreshPanel(panel, owner, repo, issueNumber, currentUser);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to edit comment: ${error.message}`);
        }
    }

    async deleteComment(owner: string, repo: string, issueNumber: number, commentId: number, panel: vscode.WebviewPanel, currentUser: any): Promise<void> {
        try {
            await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/comments/${commentId}`, {
                method: 'DELETE'
            });
            vscode.window.showInformationMessage('Comment deleted');
            await this._refreshPanel(panel, owner, repo, issueNumber, currentUser);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to delete comment: ${error.message}`);
        }
    }

    async _refreshPanel(panel: vscode.WebviewPanel, owner: string, repo: string, issueNumber: number, currentUser: any): Promise<void> {
        try {
            const [issueDetails, comments] = await Promise.all([
                this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/${issueNumber}`),
                this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/${issueNumber}/comments`)
            ]);
            panel.title = `Issue #${issueNumber}: ${issueDetails.title}`;
            panel.webview.html = await embedGiteaImages(this.auth, this.getIssueHtml(panel.webview, issueDetails, comments, currentUser));
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to refresh issue: ${error.message}`);
        }
    }

    async closeIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
        try {
            await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/${issueNumber}`, {
                method: 'PATCH',
                body: { state: 'closed' }
            });
            vscode.window.showInformationMessage(`Issue #${issueNumber} closed successfully`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to close issue: ${error.message}`);
        }
    }

    async reopenIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
        try {
            await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/${issueNumber}`, {
                method: 'PATCH',
                body: { state: 'open' }
            });
            vscode.window.showInformationMessage(`Issue #${issueNumber} reopened successfully`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to reopen issue: ${error.message}`);
        }
    }

    getIssueHtml(webview: vscode.Webview, issue: any, comments: any[], currentUser: any): string {
        const currentLogin = currentUser?.login || null;
        const stateOpen = issue.state === 'open';
        const commentCount = comments?.length || 0;

        const labelsHtml = (issue.labels && issue.labels.length > 0)
            ? issue.labels.map((l: any) => `<span class="label-pill" style="background:#${this.escapeHtml(l.color)};color:${this.getContrastColor(l.color)}">${this.escapeHtml(l.name)}</span>`).join('')
            : '';

        const commentsHtml = (comments && comments.length > 0)
            ? comments.map((c: any) => {
                const isOwn = currentLogin && c.user?.login === currentLogin;
                const cid = `c${c.id}`;
                return `
        <div class="tl-item" id="${cid}">
          <div class="avatar">${this.escapeHtml((c.user?.login || '?')[0])}</div>
          <div class="comment-box">
            <div class="comment-header">
              <span class="comment-author">${this.escapeHtml(c.user?.login || 'Unknown')}</span>
              <span class="comment-meta">commented on ${new Date(c.created_at).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'})}${c.updated_at && c.updated_at !== c.created_at ? ' &middot; edited' : ''}</span>
              ${isOwn ? `<div class="hdr-btns"><button class="btn btn-ghost btn-sm" onclick="startEdit('${cid}')">Edit</button><button class="btn btn-dghost btn-sm" onclick="delComment(${c.id})">Delete</button></div>` : ''}
            </div>
            <div class="comment-body md" id="body-${cid}">${this.renderMarkdown(c.body || '')}</div>
            <div class="edit-wrap" id="edit-${cid}">
              <textarea id="etxt-${cid}">${this.escapeHtml(c.body || '')}</textarea>
              <div class="edit-actions">
                <button class="btn btn-ghost btn-sm" onclick="cancelEdit('${cid}')">Cancel</button>
                <button class="btn btn-sm" onclick="saveEdit('${cid}',${c.id})">Save changes</button>
              </div>
            </div>
          </div>
        </div>`;
            }).join('')
            : '';

        const participantLogins = (comments || []).reduce((acc: string[], c: any) => {
            if (c.user?.login && !acc.includes(c.user.login)) acc.push(c.user.login);
            return acc;
        }, [issue.user?.login].filter(Boolean));

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*,*::before,*::after{box-sizing:border-box}
:root{
  --open:#2da44e;--closed:#8957e5;--danger:#cf222e;
  --bd:var(--vscode-panel-border);
  --bg:var(--vscode-editor-background);
  --fg:var(--vscode-foreground);
  --muted:var(--vscode-descriptionForeground);
  --hdr-bg:var(--vscode-sideBarSectionHeader-background,var(--vscode-textBlockQuote-background));
  --input-bg:var(--vscode-input-background);
  --input-fg:var(--vscode-input-foreground);
  --input-bd:var(--vscode-input-border,var(--bd));
  --btn-bg:var(--vscode-button-background);
  --btn-fg:var(--vscode-button-foreground);
  --btn-hv:var(--vscode-button-hoverBackground);
  --btn2-bg:var(--vscode-button-secondaryBackground);
  --btn2-fg:var(--vscode-button-secondaryForeground);
  --btn2-hv:var(--vscode-button-secondaryHoverBackground);
  --code-bg:var(--vscode-textCodeBlock-background);
  --link:var(--vscode-textLink-foreground);
}
body{font-family:var(--vscode-font-family),-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;color:var(--fg);background:var(--bg);margin:0;padding:0;line-height:1.5}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}

.gh-page{max-width:1200px;margin:0 auto;padding:20px 16px}

.gh-hdr{padding-bottom:16px;margin-bottom:20px;border-bottom:1px solid var(--bd)}
.gh-title{font-size:24px;font-weight:400;margin:0 0 8px;line-height:1.3;word-break:break-word}
.gh-title .num{color:var(--muted);font-weight:300}
.gh-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;color:var(--muted)}
.gh-labels-row{display:flex;flex-wrap:wrap;gap:4px;margin-top:10px}
.label-pill{display:inline-flex;align-items:center;padding:0 8px;height:20px;border-radius:2em;font-size:12px;font-weight:500}
.badge{display:inline-flex;align-items:center;gap:5px;padding:4px 12px;border-radius:2em;font-size:12px;font-weight:500;color:#fff;white-space:nowrap}
.badge-open{background:var(--open)}.badge-closed{background:var(--closed)}

.gh-layout{display:flex;gap:24px;align-items:flex-start}
.gh-main{flex:1;min-width:0}.gh-sidebar{width:244px;flex-shrink:0;font-size:13px}
@media(max-width:768px){.gh-layout{flex-direction:column}.gh-sidebar{width:100%}}

.gh-tl{position:relative}
.gh-tl::before{content:'';position:absolute;left:19px;top:44px;bottom:0;width:2px;background:var(--bd);z-index:0}
.tl-item{display:flex;gap:12px;margin-bottom:16px;position:relative;z-index:1}
.avatar{width:40px;height:40px;min-width:40px;border-radius:50%;background:var(--btn-bg);color:var(--btn-fg);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;text-transform:uppercase;border:2px solid var(--bg);z-index:1;flex-shrink:0}
.avatar-sm{width:22px;height:22px;min-width:22px;border-radius:50%;background:var(--btn-bg);color:var(--btn-fg);display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;text-transform:uppercase}

.comment-box{flex:1;min-width:0;border:1px solid var(--bd);border-radius:6px;overflow:hidden}
.comment-header{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:8px 12px;background:var(--hdr-bg);border-bottom:1px solid var(--bd);font-size:13px}
.comment-author{font-weight:600;color:var(--fg)}.comment-meta{color:var(--muted)}
.hdr-btns{margin-left:auto;display:flex;gap:4px}
.comment-body{padding:12px 16px}
.edit-wrap{display:none;padding:8px 12px;border-top:1px solid var(--bd)}
.edit-wrap textarea{width:100%;min-height:80px;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-bd);border-radius:6px;padding:8px;font-family:inherit;font-size:13px;resize:vertical;outline:none;display:block}
.edit-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}
.new-box{flex:1;min-width:0;border:1px solid var(--bd);border-radius:6px;overflow:hidden}
.new-box textarea{width:100%;min-height:100px;background:var(--input-bg);color:var(--input-fg);border:none;border-bottom:1px solid var(--bd);padding:12px;font-family:inherit;font-size:13px;resize:vertical;outline:none;display:block}
.new-box-footer{display:flex;justify-content:flex-end;padding:8px 12px;background:var(--hdr-bg)}

button{font-family:inherit;cursor:pointer;border:none;border-radius:6px;font-size:13px;font-weight:500;padding:5px 16px;line-height:20px}
.btn{background:var(--btn-bg);color:var(--btn-fg)}.btn:hover{background:var(--btn-hv)}
.btn-secondary{background:var(--btn2-bg);color:var(--btn2-fg)}.btn-secondary:hover{background:var(--btn2-hv)}
.btn-danger{background:var(--danger);color:#fff}.btn-danger:hover{background:#a40e26}
.btn-success{background:var(--open);color:#fff}.btn-success:hover{background:#2c974b}
.btn-ghost{background:transparent;color:var(--muted);padding:3px 8px}.btn-ghost:hover{color:var(--fg);background:var(--hdr-bg)}
.btn-dghost{background:transparent;color:var(--danger);padding:3px 8px}.btn-dghost:hover{background:rgba(207,34,46,.1)}
.btn-sm{padding:3px 10px;font-size:12px}
.gh-actions{display:flex;gap:8px;align-items:center;margin-top:20px;padding-top:16px;border-top:1px solid var(--bd);flex-wrap:wrap}

.sb-section{padding:16px 0;border-bottom:1px solid var(--bd)}
.sb-section:first-child{padding-top:0}.sb-section:last-child{border-bottom:none;padding-bottom:0}
.sb-heading{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px}
.sb-empty{color:var(--muted);font-size:13px}
.sb-row{display:flex;align-items:center;gap:6px;margin-bottom:4px}

.md{line-height:1.7}.md>*:first-child{margin-top:0!important}.md>*:last-child{margin-bottom:0!important}
.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{margin-top:20px;margin-bottom:12px;font-weight:600;line-height:1.3}
.md h1{font-size:1.8em;border-bottom:1px solid var(--bd);padding-bottom:.3em;margin-top:0}.md h2{font-size:1.4em;border-bottom:1px solid var(--bd);padding-bottom:.3em}
.md h3{font-size:1.2em}.md h4{font-size:1.1em}.md p{margin-top:0;margin-bottom:12px}
.md code{background:var(--code-bg);padding:.2em .4em;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:.85em}
.md pre{background:var(--code-bg);padding:12px;overflow:auto;border-radius:6px;line-height:1.5;margin:12px 0}.md pre code{background:transparent;padding:0}
.md blockquote{border-left:4px solid var(--vscode-textBlockQuote-border,var(--bd));padding-left:16px;color:var(--muted);margin:12px 0}
.md ul,.md ol{padding-left:2em;margin:8px 0 12px}.md li{margin-top:4px}
.md a{color:var(--link)}.md a:hover{text-decoration:underline}.md img{max-width:100%}
.md table{border-collapse:collapse;width:100%;margin:12px 0}.md th,.md td{border:1px solid var(--bd);padding:6px 12px}
.md th{font-weight:600;background:var(--hdr-bg)}
</style>
</head>
<body>
<div class="gh-page">

  <div class="gh-hdr">
    <h1 class="gh-title">${this.escapeHtml(issue.title)}&nbsp;<span class="num">#${issue.number}</span></h1>
    <div class="gh-meta">
      <span class="badge badge-${stateOpen ? 'open' : 'closed'}">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0">${stateOpen
          ? '<path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/>'
          : '<path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"/><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"/>'}
        </svg>
        ${stateOpen ? 'Open' : 'Closed'}
      </span>
      <span><strong>${this.escapeHtml(issue.user?.login || 'Unknown')}</strong> opened this issue ${new Date(issue.created_at).toLocaleDateString('en-US', {year:'numeric',month:'short',day:'numeric'})} &middot; ${commentCount} comment${commentCount !== 1 ? 's' : ''}</span>
    </div>
    ${labelsHtml ? `<div class="gh-labels-row">${labelsHtml}</div>` : ''}
  </div>

  <div class="gh-layout">
    <div class="gh-main">
      <div class="gh-tl">
        <div class="tl-item">
          <div class="avatar">${this.escapeHtml((issue.user?.login || '?')[0])}</div>
          <div class="comment-box">
            <div class="comment-header">
              <span class="comment-author">${this.escapeHtml(issue.user?.login || 'Unknown')}</span>
              <span class="comment-meta">opened on ${new Date(issue.created_at).toLocaleDateString('en-US', {year:'numeric',month:'short',day:'numeric'})}</span>
            </div>
            <div class="comment-body md">${issue.body ? this.renderMarkdown(issue.body) : '<em style="color:var(--muted)">No description provided.</em>'}</div>
          </div>
        </div>
        ${commentsHtml}
        <div class="tl-item">
          <div class="avatar">${this.escapeHtml((currentUser?.login || 'Y')[0])}</div>
          <div class="new-box">
            <textarea id="commentBody" placeholder="Leave a comment\u2026"></textarea>
            <div class="new-box-footer"><button class="btn" onclick="addComment()">Comment</button></div>
          </div>
        </div>
      </div>
      <div class="gh-actions">
        ${stateOpen
          ? '<button class="btn-danger" onclick="closeIssue()">Close issue</button>'
          : '<button class="btn-success" onclick="reopenIssue()">Reopen issue</button>'
        }
        <button class="btn-secondary" onclick="createBranch()">Create branch</button>
        <button class="btn-secondary" onclick="openInBrowser()">Open in browser</button>
      </div>
    </div>

    <aside class="gh-sidebar">
      <div class="sb-section">
        <span class="sb-heading">Assignees</span>
        ${issue.assignees && issue.assignees.length > 0
          ? issue.assignees.map((a: any) => `<div class="sb-row"><span class="avatar-sm">${this.escapeHtml(a.login[0])}</span><span>${this.escapeHtml(a.login)}</span></div>`).join('')
          : '<span class="sb-empty">No one assigned</span>'
        }
      </div>
      <div class="sb-section">
        <span class="sb-heading">Labels</span>
        ${labelsHtml ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${labelsHtml}</div>` : '<span class="sb-empty">None yet</span>'}
      </div>
      <div class="sb-section">
        <span class="sb-heading">Milestone</span>
        ${issue.milestone
          ? `<span>${this.escapeHtml(issue.milestone.title)}${issue.milestone.due_on ? '<br><small style="color:var(--muted)">Due ' + new Date(issue.milestone.due_on).toLocaleDateString() + '</small>' : ''}</span>`
          : '<span class="sb-empty">No milestone</span>'
        }
      </div>
      ${issue.due_date ? `<div class="sb-section"><span class="sb-heading">Due date</span><span>${new Date(issue.due_date).toLocaleDateString('en-US', {year:'numeric',month:'short',day:'numeric'})}</span></div>` : ''}
      <div class="sb-section">
        <span class="sb-heading">Participants</span>
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${participantLogins.map((l: string) => `<span class="avatar-sm" title="${this.escapeHtml(l)}">${this.escapeHtml(l[0])}</span>`).join('')}
        </div>
      </div>
    </aside>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
function addComment() {
  var b = document.getElementById('commentBody').value.trim();
  if (!b) return;
  vscode.postMessage({ command: 'addComment', body: b });
  document.getElementById('commentBody').value = '';
}
function startEdit(id) {
  document.getElementById('body-' + id).style.display = 'none';
  document.getElementById('edit-' + id).style.display = 'block';
}
function cancelEdit(id) {
  document.getElementById('edit-' + id).style.display = 'none';
  document.getElementById('body-' + id).style.display = '';
}
function saveEdit(id, cid) {
  var b = document.getElementById('etxt-' + id).value.trim();
  if (!b) return;
  vscode.postMessage({ command: 'editComment', commentId: cid, body: b });
}
function delComment(cid) {
  dlg('Delete comment', 'Delete this comment permanently?', function() {
    vscode.postMessage({ command: 'deleteComment', commentId: cid });
  });
}
function closeIssue() {
  dlg('Close issue', 'Are you sure you want to close this issue?', function() {
    vscode.postMessage({ command: 'closeIssue' });
  });
}
function reopenIssue() { vscode.postMessage({ command: 'reopenIssue' }); }
function createBranch() { vscode.postMessage({ command: 'createBranch' }); }
function openInBrowser() { vscode.postMessage({ command: 'openInBrowser' }); }
function dlg(title, msg, cb) {
  var ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999';
  var bx = document.createElement('div');
  bx.style.cssText = 'background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:24px;max-width:360px;width:90%;box-shadow:0 8px 24px rgba(0,0,0,.3)';
  var h = document.createElement('h3'); h.textContent = title; h.style.cssText = 'margin:0 0 8px;font-size:15px';
  var p = document.createElement('p'); p.textContent = msg; p.style.cssText = 'margin:0 0 20px;color:var(--muted);font-size:13px';
  var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
  var cn = document.createElement('button'); cn.textContent = 'Cancel';
  cn.style.cssText = 'background:var(--btn2-bg);color:var(--btn2-fg);border:none;border-radius:6px;padding:5px 16px;cursor:pointer;font-size:13px';
  cn.onclick = function() { ov.remove(); };
  var ok = document.createElement('button'); ok.textContent = 'Confirm';
  ok.style.cssText = 'background:var(--btn-bg);color:var(--btn-fg);border:none;border-radius:6px;padding:5px 16px;cursor:pointer;font-size:13px;font-weight:500';
  ok.onclick = function() { ov.remove(); cb(); };
  row.append(cn, ok); bx.append(h, p, row); ov.append(bx); document.body.append(ov);
}
</script>
</body>
</html>`;
    }

    escapeHtml(text: any): string {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    getContrastColor(hexColor: string): string {
        try {
            if (!hexColor) return '#000000';
            const hex = hexColor.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            if (isNaN(r) || isNaN(g) || isNaN(b)) return '#000000';
            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
            return brightness > 155 ? '#000000' : '#ffffff';
        } catch (error) {
            console.error('Failed to calculate contrast color:', error);
            return '#000000';
        }
    }

    renderMarkdown(text: string): string {
        if (!text) return '';
        try {
            return marked.parse(text) as string;
        } catch (error) {
            void (error);
            return this.escapeHtml(text);
        }
    }

    async showCreateIssue(repositories: GiteaRepository[]): Promise<void> {
        try {
            const panel = vscode.window.createWebviewPanel(
                'giteaCreateIssue',
                'Create New Issue',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            panel.webview.onDidReceiveMessage(async (message: any) => {
                try {
                    switch (message.command) {
                        case 'loadBranches':
                            const branches = await this.loadBranches(message.repository);
                            panel.webview.postMessage({ command: 'branchesLoaded', branches });
                            break;
                        case 'checkDuplicates':
                            const duplicates = await this.checkDuplicates(message.repository, message.title, message.body);
                            panel.webview.postMessage({ command: 'duplicatesChecked', duplicates });
                            break;
                        case 'createIssue':
                            await this.createIssue(message.data);
                            panel.dispose();
                            break;
                    }
                } catch (error: any) {
                    console.error('Error handling webview message:', error);
                    vscode.window.showErrorMessage(`Error: ${error.message}`);
                }
            });

            panel.webview.html = this.getCreateIssueHtml(panel.webview, repositories);
        } catch (error: any) {
            console.error('Failed to show create issue form:', error);
            vscode.window.showErrorMessage(`Failed to show create issue form: ${error.message}`);
        }
    }

    async loadBranches(repository: string): Promise<string[]> {
        try {
            const [owner, repo] = repository.split('/');
            const branches = await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/branches`);
            return branches.map((b: any) => b.name);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to load branches: ${error.message}`);
            return [];
        }
    }

    calculateStringSimilarity(str1: string, str2: string): number {
        const s1 = String(str1 || '').toLowerCase();
        const s2 = String(str2 || '').toLowerCase();

        if (s1 === s2) return 1;
        if (s1.length === 0 || s2.length === 0) return 0;

        const longer = s1.length > s2.length ? s1 : s2;
        const shorter = s1.length > s2.length ? s2 : s1;

        const editDistance = this.getLevenshteinDistance(shorter, longer);
        return (longer.length - editDistance) / longer.length;
    }

    getLevenshteinDistance(s1: string, s2: string): number {
        const costs: number[] = [];
        for (let i = 0; i <= s1.length; i++) {
            let lastValue = i;
            for (let j = 0; j <= s2.length; j++) {
                if (i === 0) {
                    costs[j] = j;
                } else if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
            if (i > 0) costs[s2.length] = lastValue;
        }
        return costs[s2.length];
    }

    async checkDuplicates(repository: string, title: string, body: string): Promise<any[]> {
        try {
            const [owner, repo] = repository.split('/');
            const existingIssues = await this.auth.makeRequest(
                `/api/v1/repos/${owner}/${repo}/issues?state=all&limit=100`
            );

            if (!Array.isArray(existingIssues) || existingIssues.length === 0) {
                return [];
            }

            const duplicates: any[] = [];
            const threshold = 0.7;

            existingIssues.forEach((existingIssue: any) => {
                if (existingIssue.pull_request) return;

                const titleSimilarity = this.calculateStringSimilarity(title, existingIssue.title);

                let bodySimilarity = 0;
                if (body && existingIssue.body) {
                    bodySimilarity = this.calculateStringSimilarity(body, existingIssue.body);
                }

                const combinedScore = titleSimilarity * 0.7 + bodySimilarity * 0.3;

                if (combinedScore >= threshold) {
                    duplicates.push({
                        number: existingIssue.number,
                        title: existingIssue.title,
                        state: existingIssue.state,
                        url: existingIssue.html_url,
                        similarity: Math.round(combinedScore * 100),
                        created_at: existingIssue.created_at,
                        updated_at: existingIssue.updated_at
                    });
                }
            });

            duplicates.sort((a: any, b: any) => b.similarity - a.similarity);
            return duplicates;
        } catch (error) {
            console.error('Error checking duplicates:', error);
            return [];
        }
    }

    async createIssue(data: any): Promise<void> {
        try {
            const [owner, repo] = data.repository.split('/');

            const requestBody: any = {
                title: data.title,
                body: data.body || '',
                labels: data.labels ? data.labels.split(',').map((l: string) => l.trim()).filter(Boolean) : []
            };

            if (data.branch) {
                requestBody.ref = data.branch;
            }

            const result = await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues`, {
                method: 'POST',
                body: requestBody
            });
            vscode.window.showInformationMessage(`Issue #${result.number} created successfully!`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to create issue: ${error.message}`);
        }
    }

    getCreateIssueHtml(webview: vscode.Webview, repositories: GiteaRepository[]): string {
        const repoOptions = repositories.map(repo =>
            `<option value="${repo.full_name}">${repo.full_name}</option>`
        ).join('');

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            line-height: 1.6;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            font-weight: 600;
            margin-bottom: 6px;
            font-size: 14px;
        }
        input, select, textarea {
            width: 100%;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 8px;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            box-sizing: border-box;
        }
        textarea {
            min-height: 150px;
            resize: vertical;
        }
        .hint {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        .button-group {
            display: flex;
            gap: 8px;
            margin-top: 24px;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        h1 {
            font-size: 24px;
            margin-top: 0;
            margin-bottom: 24px;
        }
        .duplicate-results {
            background-color: var(--vscode-editor-inlineValue-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 12px;
            margin-top: 16px;
            display: none;
        }
        .duplicate-results.show {
            display: block;
        }
        .duplicate-item {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            padding: 8px;
            margin-bottom: 8px;
        }
        .duplicate-item:last-child {
            margin-bottom: 0;
        }
        .duplicate-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 4px;
        }
        .duplicate-title {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            font-weight: 500;
            flex: 1;
        }
        .duplicate-score {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            white-space: nowrap;
            margin-left: 8px;
        }
        .duplicate-meta {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .no-duplicates {
            color: var(--vscode-textLink-foreground);
            font-size: 13px;
        }
        .checking-status {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
    </style>
</head>
<body>
    <h1>Create New Issue</h1>
    <form id="issueForm">
        <div class="form-group">
            <label for="repository">Repository *</label>
            <select id="repository" required>
                <option value="">Select a repository...</option>
                ${repoOptions}
            </select>
        </div>
        
        <div class="form-group">
            <label for="title">Title *</label>
            <input type="text" id="title" placeholder="Brief description of the issue" required>
        </div>
        
        <div class="form-group">
            <label for="body">Description</label>
            <textarea id="body" placeholder="Provide more details about the issue..."></textarea>
            <div class="hint">Supports Markdown formatting</div>
        </div>
        
        <div class="form-group">
            <label for="labels">Labels</label>
            <input type="text" id="labels" placeholder="bug, enhancement, documentation">
            <div class="hint">Comma-separated list of labels</div>
        </div>
        
        <div class="form-group">
            <label for="branch">Branch</label>
            <select id="branch">
                <option value="">Select a branch...</option>
            </select>
            <div class="hint">Optional: tag this issue with a specific branch</div>
        </div>
        
        <div id="duplicateResults" class="duplicate-results">
            <div id="duplicateHeader" style="margin-bottom: 12px; font-weight: 500; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px;">
                Potential Duplicate Issues Found
            </div>
            <div id="duplicateList"></div>
        </div>
        
        <div class="button-group">
            <button type="button" id="checkDuplicatesBtn" class="secondary" style="flex: 1;">Check for Duplicates</button>
        </div>
        
        <div class="button-group">
            <button type="submit">Create Issue</button>
            <button type="button" class="secondary" onclick="window.close()">Cancel</button>
        </div>
    </form>

    <script>
        const vscode = acquireVsCodeApi();
        let isCheckingDuplicates = false;
        
        document.getElementById('repository').addEventListener('change', async (e) => {
            const repository = e.target.value;
            if (repository) {
                vscode.postMessage({ command: 'loadBranches', repository });
            }
            document.getElementById('duplicateResults').classList.remove('show');
        });
        
        document.getElementById('checkDuplicatesBtn').addEventListener('click', async (e) => {
            e.preventDefault();
            const repository = document.getElementById('repository').value;
            const title = document.getElementById('title').value;
            const body = document.getElementById('body').value;
            
            if (!repository) {
                alert('Please select a repository first');
                return;
            }
            
            if (!title) {
                alert('Please enter a title first');
                return;
            }
            
            if (isCheckingDuplicates) return;
            
            isCheckingDuplicates = true;
            const btn = document.getElementById('checkDuplicatesBtn');
            const originalText = btn.textContent;
            btn.textContent = 'Checking for duplicates...';
            btn.disabled = true;
            
            vscode.postMessage({
                command: 'checkDuplicates',
                repository: repository,
                title: title,
                body: body
            });
        });
        
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'branchesLoaded') {
                const branchSelect = document.getElementById('branch');
                branchSelect.innerHTML = '<option value="">Select a branch...</option>';
                
                message.branches.forEach(branch => {
                    const opt = document.createElement('option');
                    opt.value = branch;
                    opt.textContent = branch;
                    branchSelect.appendChild(opt);
                });

                const defaultBranches = ['main', 'master'];
                for (const defaultBranch of defaultBranches) {
                    if (message.branches.includes(defaultBranch)) {
                        branchSelect.value = defaultBranch;
                        break;
                    }
                }
            } else if (message.command === 'duplicatesChecked') {
                isCheckingDuplicates = false;
                const btn = document.getElementById('checkDuplicatesBtn');
                btn.textContent = 'Check for Duplicates';
                btn.disabled = false;
                
                const resultsDiv = document.getElementById('duplicateResults');
                const listDiv = document.getElementById('duplicateList');
                
                if (message.duplicates && message.duplicates.length > 0) {
                    resultsDiv.classList.add('show');
                    const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
                    listDiv.innerHTML = message.duplicates.map(dup => \`
                        <div class="duplicate-item">
                            <div class="duplicate-header">
                                <a href="\${escHtml(dup.url)}" class="duplicate-title" target="_blank">
                                    #\${escHtml(dup.number)}: \${escHtml(dup.title)}
                                </a>
                                <span class="duplicate-score">\${escHtml(dup.similarity)}% match</span>
                            </div>
                            <div class="duplicate-meta">
                                State: <strong>\${escHtml(dup.state)}</strong> | Updated: \${escHtml(new Date(dup.updated_at).toLocaleDateString())}
                            </div>
                        </div>
                    \`).join('');
                } else {
                    resultsDiv.classList.add('show');
                    listDiv.innerHTML = '<div class="no-duplicates">✓ No duplicate issues found</div>';
                }
            }
        });
        
        document.getElementById('issueForm').addEventListener('submit', (e) => {
            e.preventDefault();
            
            const repository = document.getElementById('repository').value;
            const title = document.getElementById('title').value;
            const body = document.getElementById('body').value;
            const labels = document.getElementById('labels').value;
            const branch = document.getElementById('branch').value;
            
            if (!repository || !title) {
                return;
            }
            
            vscode.postMessage({
                command: 'createIssue',
                data: { repository, title, body, labels, branch }
            });
        });
    </script>
</body>
</html>`;
    }
}

class PullRequestCreationProvider {
    private auth: GiteaAuth;

    constructor(auth: GiteaAuth) {
        this.auth = auth;
    }

    async showCreatePullRequest(repositories: GiteaRepository[]): Promise<void> {
        try {
            const panel = vscode.window.createWebviewPanel(
                'giteaCreatePR',
                'Create New Pull Request',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            panel.webview.onDidReceiveMessage(async (message: any) => {
                try {
                    switch (message.command) {
                        case 'loadBranches':
                            const branches = await this.loadBranches(message.repository);
                            panel.webview.postMessage({ command: 'branchesLoaded', branches });
                            break;
                        case 'loadDiff':
                            const diff = await this.loadDiff(message.repository, message.base, message.head);
                            panel.webview.postMessage({ command: 'diffLoaded', diff });
                            break;
                        case 'createPR':
                            await this.createPullRequest(message.data);
                            panel.dispose();
                            break;
                    }
                } catch (error: any) {
                    console.error('Error handling webview message:', error);
                    vscode.window.showErrorMessage(`Error: ${error.message}`);
                }
            });

            panel.webview.html = this.getCreatePRHtml(panel.webview, repositories);
        } catch (error: any) {
            console.error('Failed to show create pull request form:', error);
            vscode.window.showErrorMessage(`Failed to show create pull request form: ${error.message}`);
        }
    }

    async loadBranches(repository: string): Promise<string[]> {
        try {
            const [owner, repo] = repository.split('/');
            const branches = await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/branches`);
            return branches.map((b: any) => b.name);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to load branches: ${error.message}`);
            return [];
        }
    }

    async loadDiff(repository: string, base: string, head: string): Promise<any> {
        try {
            const [owner, repo] = repository.split('/');
            const compare = await this.auth.makeRequest(
                `/api/v1/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
            );
            return { ok: true, data: compare };
        } catch (error: any) {
            return { ok: false, error: error.message };
        }
    }

    async createPullRequest(data: any): Promise<void> {
        try {
            const [owner, repo] = data.repository.split('/');
            const result = await this.auth.makeRequest(`/api/v1/repos/${owner}/${repo}/pulls`, {
                method: 'POST',
                body: {
                    title: data.title,
                    body: data.body,
                    head: data.head,
                    base: data.base,
                    assignees: data.assignees ? data.assignees.split(',').map((a: string) => a.trim()).filter(Boolean) : []
                }
            });
            vscode.window.showInformationMessage(`Pull Request #${result.number} created successfully!`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to create pull request: ${error.message}`);
        }
    }

    getCreatePRHtml(webview: vscode.Webview, repositories: GiteaRepository[]): string {
        const repoOptions = repositories.map(repo =>
            `<option value="${repo.full_name}">${repo.full_name}</option>`
        ).join('');

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root {
  --bd:var(--vscode-panel-border);--bg:var(--vscode-editor-background);--fg:var(--vscode-foreground);--fg2:var(--vscode-descriptionForeground);
  --inp-bg:var(--vscode-input-background);--inp-fg:var(--vscode-input-foreground);--inp-bd:var(--vscode-input-border,var(--bd));
  --hdr-bg:var(--vscode-sideBarSectionHeader-background,rgba(128,128,128,.08));
  --btn-bg:var(--vscode-button-background);--btn-fg:var(--vscode-button-foreground);--btn-hov:var(--vscode-button-hoverBackground);
  --btn2-bg:var(--vscode-button-secondaryBackground);--btn2-fg:var(--vscode-button-secondaryForeground);
  --link:var(--vscode-textLink-foreground);--code-bg:var(--vscode-textCodeBlock-background);
}
*{box-sizing:border-box}
body{font-family:var(--vscode-font-family);font-size:14px;color:var(--fg);background:var(--bg);margin:0;padding:20px;line-height:1.6}
h1{font-size:20px;font-weight:600;margin:0 0 20px}
.form-group{margin-bottom:16px}
label{display:block;font-weight:600;margin-bottom:6px;font-size:13px}
input,select,textarea{width:100%;background:var(--inp-bg);color:var(--inp-fg);border:1px solid var(--inp-bd);border-radius:6px;padding:7px 10px;font-family:inherit;font-size:13px}
textarea{min-height:120px;resize:vertical}
.hint{font-size:11px;color:var(--fg2);margin-top:4px}
.branch-row{display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:start}
.arrow{font-size:20px;color:var(--fg2);padding-top:4px;text-align:center}
.btn-row{display:flex;gap:8px;margin-top:20px}
.btn{padding:6px 16px;border-radius:6px;border:none;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit}
.btn-primary{background:var(--btn-bg);color:var(--btn-fg)}.btn-primary:hover{background:var(--btn-hov)}
.btn-secondary{background:var(--btn2-bg);color:var(--btn2-fg)}

/* Diff preview */
#diffPreview{margin-top:24px;border-top:1px solid var(--bd);padding-top:16px;display:none}
.diff-hdr{font-size:14px;font-weight:600;margin-bottom:12px}
.diff-loading{display:flex;align-items:center;gap:8px;color:var(--fg2);font-size:13px}
.spinner{width:14px;height:14px;border:2px solid var(--bd);border-top-color:var(--link);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.diff-error{color:var(--vscode-errorForeground);font-size:13px}
.stats-bar{display:flex;gap:16px;font-size:13px;padding:10px 12px;background:var(--hdr-bg);border:1px solid var(--bd);border-radius:6px;margin-bottom:12px;flex-wrap:wrap}
.stat{display:flex;align-items:center;gap:4px;color:var(--fg2)}.stat b{color:var(--fg)}
.add{color:#3fb950}.del{color:#f85149}
.section-hdr{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--fg2);margin:14px 0 6px}
.commit-row{border:1px solid var(--bd);border-radius:6px;padding:8px 12px;margin-bottom:6px}
.commit-msg{font-size:13px;font-weight:500;word-break:break-word;margin-bottom:3px}
.commit-meta{font-size:11px;color:var(--fg2)}
.commit-sha{font-family:var(--vscode-editor-font-family);background:var(--code-bg);padding:1px 5px;border-radius:4px}
.file-item{border:1px solid var(--bd);border-radius:6px;margin-bottom:6px;overflow:hidden}
.file-hdr{display:flex;align-items:center;padding:7px 12px;background:var(--hdr-bg);cursor:pointer;font-size:13px;gap:8px;user-select:none}
.file-hdr:hover{background:var(--vscode-list-hoverBackground)}
.file-name{flex:1;font-family:var(--vscode-editor-font-family);font-size:12px}
.file-stats{display:flex;gap:8px;font-size:12px;font-family:var(--vscode-editor-font-family);white-space:nowrap}
.file-diff{background:var(--code-bg);padding:6px;font-family:var(--vscode-editor-font-family);font-size:12px;line-height:1.5;overflow-x:auto;display:none}
.diff-line{display:block;white-space:pre;padding:0 6px}
.diff-line.addition{background:rgba(63,185,80,.15)}
.diff-line.deletion{background:rgba(248,81,73,.15)}
.diff-line.context{color:var(--fg2)}
.diff-line.hunk{color:var(--link);font-weight:600}
.chevron{transition:transform .15s;font-size:11px;color:var(--fg2)}
.chevron.open{transform:rotate(90deg)}
</style>
</head>
<body>
<h1>Create New Pull Request</h1>
<form id="prForm">
  <div class="form-group">
    <label for="repository">Repository *</label>
    <select id="repository" required>
      <option value="">Select a repository...</option>
      ${repoOptions}
    </select>
  </div>

  <div class="form-group">
    <label>Branches *</label>
    <div class="branch-row">
      <div>
        <select id="base" required>
          <option value="">Base branch...</option>
        </select>
        <div class="hint">Target branch (merge into)</div>
      </div>
      <div class="arrow">←</div>
      <div>
        <select id="head" required>
          <option value="">Compare branch...</option>
        </select>
        <div class="hint">Your changes</div>
      </div>
    </div>
  </div>

  <div class="form-group">
    <label for="title">Title *</label>
    <input type="text" id="title" placeholder="Brief description of the changes" required>
  </div>

  <div class="form-group">
    <label for="body">Description</label>
    <textarea id="body" placeholder="Describe the changes in detail..."></textarea>
    <div class="hint">Supports Markdown formatting</div>
  </div>

  <div class="form-group">
    <label for="assignees">Assignees</label>
    <input type="text" id="assignees" placeholder="username1, username2">
    <div class="hint">Comma-separated list of usernames</div>
  </div>

  <div class="btn-row">
    <button type="submit" class="btn btn-primary">Create Pull Request</button>
    <button type="button" class="btn btn-secondary" onclick="window.close()">Cancel</button>
  </div>
</form>

<div id="diffPreview">
  <div class="diff-hdr">Comparing branches</div>
  <div id="diffContent"></div>
</div>

<script>
const vscode = acquireVsCodeApi();
let diffPending = null;

function triggerDiff() {
  const repo = document.getElementById('repository').value;
  const base = document.getElementById('base').value;
  const head = document.getElementById('head').value;
  if (!repo || !base || !head || base === head) {
    document.getElementById('diffPreview').style.display = 'none';
    return;
  }
  const key = repo + '|' + base + '|' + head;
  if (diffPending === key) return;
  diffPending = key;
  document.getElementById('diffPreview').style.display = 'block';
  document.getElementById('diffContent').innerHTML =
    '<div class="diff-loading"><div class="spinner"></div>Loading diff\u2026</div>';
  vscode.postMessage({ command: 'loadDiff', repository: repo, base, head });
}

document.getElementById('repository').addEventListener('change', e => {
  if (e.target.value) {
    vscode.postMessage({ command: 'loadBranches', repository: e.target.value });
    document.getElementById('diffPreview').style.display = 'none';
    diffPending = null;
  }
});
document.getElementById('base').addEventListener('change', triggerDiff);
document.getElementById('head').addEventListener('change', triggerDiff);

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.command === 'branchesLoaded') {
    const baseEl = document.getElementById('base');
    const headEl = document.getElementById('head');
    baseEl.innerHTML = '<option value="">Base branch...</option>';
    headEl.innerHTML = '<option value="">Compare branch...</option>';
    msg.branches.forEach(b => {
      const o1 = document.createElement('option'); o1.value = o1.textContent = b; baseEl.appendChild(o1);
      const o2 = document.createElement('option'); o2.value = o2.textContent = b; headEl.appendChild(o2);
    });
    for (const def of ['main', 'master']) {
      if (msg.branches.includes(def)) { baseEl.value = def; break; }
    }
    diffPending = null;
    triggerDiff();
  }
  if (msg.command === 'diffLoaded') {
    renderDiff(msg.diff);
  }
});

function renderDiff(result) {
  const el = document.getElementById('diffContent');
  if (!result.ok) {
    el.innerHTML = '<div class="diff-error">Could not load diff: ' + escHtml(result.error) + '</div>';
    return;
  }
  const d = result.data;
  const commits = d.commits || [];
  const files = d.files || [];
  const totalAdd = d.diff_stats?.total_additions ?? files.reduce((s, f) => s + (f.additions || 0), 0);
  const totalDel = d.diff_stats?.total_deletions ?? files.reduce((s, f) => s + (f.deletions || 0), 0);

  if (!document.getElementById('title').value && commits.length > 0) {
    const firstMsg = commits[0].commit?.message || commits[0].message || '';
    document.getElementById('title').value = firstMsg.split('\\n')[0].trim();
  }

  let html = '<div class="stats-bar">';
  html += '<span class="stat">Commits: <b>' + commits.length + '</b></span>';
  html += '<span class="stat">Files changed: <b>' + files.length + '</b></span>';
  html += '<span class="stat add">+' + totalAdd + '</span>';
  html += '<span class="stat del">-' + totalDel + '</span>';
  html += '</div>';

  if (commits.length > 0) {
    html += '<div class="section-hdr">Commits</div>';
    for (const c of commits) {
      const sha = (c.sha || '').substring(0, 7);
      const msg = escHtml(c.commit?.message || c.message || 'No message');
      const author = escHtml(c.commit?.author?.name || c.author?.login || 'Unknown');
      const date = new Date(c.commit?.author?.date || c.created_at || '').toLocaleString();
      html += '<div class="commit-row"><div class="commit-msg">' + msg.split('\\n')[0] + '</div>';
      html += '<div class="commit-meta">' + author + ' · <span class="commit-sha">' + sha + '</span> · ' + date + '</div></div>';
    }
  }

  if (files.length > 0) {
    html += '<div class="section-hdr">Files changed (' + files.length + ')</div>';
    files.forEach((f, i) => {
      const name = escHtml(f.filename || f.name || '');
      const adds = f.additions || 0;
      const dels = f.deletions || 0;
      html += '<div class="file-item">';
      html += '<div class="file-hdr" onclick="toggleFile(' + i + ')">';
      html += '<span class="chevron" id="chev-' + i + '">\u2039</span>';
      html += '<span class="file-name">' + name + '</span>';
      html += '<span class="file-stats"><span class="add">+' + adds + '</span> <span class="del">-' + dels + '</span></span>';
      html += '</div>';
      html += '<div class="file-diff" id="fdiff-' + i + '">' + renderPatch(f.patch) + '</div>';
      html += '</div>';
    });
  }

  el.innerHTML = html;
}

function toggleFile(i) {
  const diff = document.getElementById('fdiff-' + i);
  const chev = document.getElementById('chev-' + i);
  if (!diff) return;
  const open = diff.style.display !== 'block';
  diff.style.display = open ? 'block' : 'none';
  if (chev) chev.className = 'chevron' + (open ? ' open' : '');
}

function renderPatch(patch) {
  if (!patch) return '<span style="color:var(--fg2);padding:6px;display:block">No diff available</span>';
  return patch.split('\\n').map(line => {
    let cls = 'context';
    if (line.startsWith('+')) cls = 'addition';
    else if (line.startsWith('-')) cls = 'deletion';
    else if (line.startsWith('@@')) cls = 'hunk';
    return '<span class="diff-line ' + cls + '">' + escHtml(line) + '</span>';
  }).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.getElementById('prForm').addEventListener('submit', e => {
  e.preventDefault();
  const repository = document.getElementById('repository').value;
  const base = document.getElementById('base').value;
  const head = document.getElementById('head').value;
  const title = document.getElementById('title').value;
  const body = document.getElementById('body').value;
  const assignees = document.getElementById('assignees').value;
  if (!repository || !base || !head || !title) return;
  if (base === head) { alert('Base and compare branches must be different.'); return; }
  vscode.postMessage({ command: 'createPR', data: { repository, base, head, title, body, assignees } });
});
</script>
</body>
</html>`;
    }
}

class VersionInfoProvider {
    private auth: GiteaAuth;
    private context: vscode.ExtensionContext;
    private _panel: vscode.WebviewPanel | null;

    constructor(auth: GiteaAuth, context: vscode.ExtensionContext) {
        this.auth = auth;
        this.context = context;
        this._panel = null;
    }

    async show(): Promise<void> {
        const extensionVersion = this.context.extension.packageJSON.version;
        const vsCodeVersion = vscode.version;

        if (this._panel) {
            this._panel.reveal();
            this._refreshGiteaVersion();
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'gitea.versionInfo',
            'Gitea: Version Info',
            vscode.ViewColumn.Active,
            { enableScripts: true }
        );

        this._panel.onDidDispose(() => { this._panel = null; });

        this._panel.webview.onDidReceiveMessage(async (message: any) => {
            if (message.command === 'copyToClipboard') {
                await vscode.env.clipboard.writeText(message.text);
                this._panel?.webview.postMessage({ command: 'copied' });
            } else if (message.command === 'refreshGiteaVersion') {
                this._refreshGiteaVersion();
            }
        });

        this._panel.webview.html = this._buildHtml(extensionVersion, vsCodeVersion);
        this._refreshGiteaVersion();
    }

    async _refreshGiteaVersion(): Promise<void> {
        if (!this._panel) return;
        try {
            if (!this.auth.isConfigured()) {
                this._panel.webview.postMessage({ command: 'setGiteaVersion', version: null, error: 'Not configured' });
                return;
            }
            const response = await this.auth.makeRequest('/api/v1/version');
            const version = (response && response.version) ? response.version : 'Unknown';
            this._panel?.webview.postMessage({ command: 'setGiteaVersion', version, error: null });
        } catch (error: any) {
            this._panel?.webview.postMessage({ command: 'setGiteaVersion', version: null, error: error.message });
        }
    }

    _buildHtml(extensionVersion: string, vsCodeVersion: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Version Info</title>
<style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 24px;
        max-width: 480px;
        margin: 0 auto;
    }
    h2 {
        font-size: 15px;
        font-weight: 600;
        margin: 0 0 20px 0;
        color: var(--vscode-foreground);
        border-bottom: 1px solid var(--vscode-panel-border);
        padding-bottom: 10px;
    }
    .card {
        background: var(--vscode-sideBar-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        padding: 14px 16px;
        margin-bottom: 10px;
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
    }
    .value {
        font-size: 16px;
        font-weight: 600;
        font-family: var(--vscode-editor-font-family, monospace);
    }
    .loading { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 14px; font-weight: normal; }
    .error-text { color: var(--vscode-errorForeground); font-size: 13px; font-weight: normal; }
    .copy-btn {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none;
        padding: 4px 12px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
        flex-shrink: 0;
        margin-left: 12px;
    }
    .copy-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .copy-all-btn {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 8px 16px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 13px;
        width: 100%;
        margin-top: 8px;
    }
    .copy-all-btn:hover { background: var(--vscode-button-hoverBackground); }
    .status {
        text-align: center;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-top: 8px;
        min-height: 16px;
    }
    .refresh-btn {
        background: none;
        border: none;
        color: var(--vscode-textLink-foreground);
        cursor: pointer;
        font-size: 12px;
        padding: 0;
        text-decoration: underline;
    }
</style>
</head>
<body>
<h2>Version Information</h2>

<div class="card">
    <div>
        <div class="label">Extension</div>
        <div class="value" id="ext-ver">${extensionVersion}</div>
    </div>
    <button class="copy-btn" onclick="copyText('ext-ver')">Copy</button>
</div>

<div class="card">
    <div>
        <div class="label">VS Code</div>
        <div class="value" id="vscode-ver">${vsCodeVersion}</div>
    </div>
    <button class="copy-btn" onclick="copyText('vscode-ver')">Copy</button>
</div>

<div class="card">
    <div>
        <div class="label">Gitea <button class="refresh-btn" onclick="requestRefresh()" id="refresh-btn">(refresh)</button></div>
        <div class="value" id="gitea-ver"><span class="loading">Fetching...</span></div>
    </div>
    <button class="copy-btn" id="copy-gitea-btn" onclick="copyText('gitea-ver')" disabled>Copy</button>
</div>

<button class="copy-all-btn" id="copy-all-btn" onclick="copyAll()" disabled>Copy All to Clipboard</button>
<div class="status" id="status"></div>

<script>
    const vscode = acquireVsCodeApi();
    let giteaReady = false;

    function copyText(id) {
        const text = document.getElementById(id).textContent.trim();
        vscode.postMessage({ command: 'copyToClipboard', text });
    }

    function copyAll() {
        const ext = document.getElementById('ext-ver').textContent.trim();
        const vs = document.getElementById('vscode-ver').textContent.trim();
        const gitea = document.getElementById('gitea-ver').textContent.trim();
        const text = 'Gitea Extension: ' + ext + '\\nVS Code: ' + vs + '\\nGitea Server: ' + gitea;
        vscode.postMessage({ command: 'copyToClipboard', text });
    }

    function requestRefresh() {
        document.getElementById('gitea-ver').innerHTML = '<span class="loading">Fetching...</span>';
        document.getElementById('copy-gitea-btn').disabled = true;
        document.getElementById('copy-all-btn').disabled = true;
        document.getElementById('refresh-btn').disabled = true;
        giteaReady = false;
        vscode.postMessage({ command: 'refreshGiteaVersion' });
    }

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.command === 'setGiteaVersion') {
            const el = document.getElementById('gitea-ver');
            if (msg.error) {
                el.innerHTML = '<span class="error-text">Unavailable (' + msg.error + ')</span>';
            } else {
                el.textContent = msg.version;
                giteaReady = true;
                document.getElementById('copy-gitea-btn').disabled = false;
                document.getElementById('copy-all-btn').disabled = false;
            }
            document.getElementById('refresh-btn').disabled = false;
        } else if (msg.command === 'copied') {
            const el = document.getElementById('status');
            el.textContent = 'Copied to clipboard';
            setTimeout(() => { el.textContent = ''; }, 2000);
        }
    });
</script>
</body>
</html>`;
    }
}

export { PullRequestWebviewProvider, IssueWebviewProvider, PullRequestCreationProvider, VersionInfoProvider }