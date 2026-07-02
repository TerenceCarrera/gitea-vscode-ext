import * as vscode from 'vscode';
import GiteaAuth from './auth';
import { ImportedIssue, ImportResults, ImportOptions, DuplicateMatch, GiteaIssue } from './types';

export function parseXlsxFile(filePath: string): ImportedIssue[] {
    try {
        let XLSX: any;
        try {
            XLSX = require('xlsx');
        } catch {
            throw new Error('xlsx module not found. Please ensure the extension is properly installed.');
        }

        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        const data = XLSX.utils.sheet_to_json(worksheet) as Array<Record<string, unknown>>;

        if (!data || data.length === 0) {
            throw new Error('No data found in XLSX file');
        }

        const issues = data.map((row, index) => {
            const title = row['Title'] || row['title'] || row['TITLE'];
            if (!title || String(title).trim() === '') {
                throw new Error(`Row ${index + 2}: Title column is required and cannot be empty`);
            }

            return {
                title: String(title).trim(),
                body: String(row['Description'] || row['description'] || row['DESCRIPTION'] || '').trim(),
                labels: parseLabels(String(row['Labels'] || row['labels'] || row['LABELS'] || '')),
                assignee: (row['Assignee'] || row['assignee'] || row['ASSIGNEE'] || '').toString().trim(),
                milestone: (row['Milestone'] || row['milestone'] || row['MILESTONE'] || '').toString().trim(),
                state: (row['State'] || row['state'] || row['STATE'] || 'open').toString().toLowerCase(),
                priority: (row['Priority'] || row['priority'] || row['PRIORITY'] || '').toString().trim(),
                dueDate: (row['Due Date'] || row['due_date'] || row['DUE_DATE'] || '').toString().trim()
            };
        });

        return issues;
    } catch (error: any) {
        throw new Error(`Failed to parse XLSX file: ${error.message}`);
    }
}

export function parseLabels(labelsStr: string): string[] {
    if (!labelsStr || typeof labelsStr !== 'string') {
        return [];
    }
    return labelsStr
        .split(/[,;]/)
        .map(label => label.trim())
        .filter(label => label.length > 0);
}

export function calculateStringSimilarity(str1: string, str2: string): number {
    const s1 = String(str1 || '').toLowerCase();
    const s2 = String(str2 || '').toLowerCase();

    if (s1 === s2) return 1;
    if (s1.length === 0 || s2.length === 0) return 0;

    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;

    const editDistance = getLevenshteinDistance(shorter, longer);
    return (longer.length - editDistance) / longer.length;
}

export function getLevenshteinDistance(s1: string, s2: string): number {
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

export async function fetchAllIssues(auth: GiteaAuth, owner: string, repo: string, pageSize: number = 50): Promise<GiteaIssue[]> {
    const allIssues: GiteaIssue[] = [];
    let page = 1;
    let hasMore = true;

    try {
        while (hasMore) {
            const issues = await auth.makeRequest(
                `/api/v1/repos/${owner}/${repo}/issues?state=all&limit=${pageSize}&page=${page}`
            ) as GiteaIssue[];

            if (!Array.isArray(issues) || issues.length === 0) {
                hasMore = false;
            } else {
                issues.forEach(issue => {
                    if (!issue.pull_request) {
                        allIssues.push(issue);
                    }
                });

                if (issues.length < pageSize) {
                    hasMore = false;
                } else {
                    page++;
                }
            }
        }

        return allIssues;
    } catch (error: any) {
        console.error('Error fetching all issues:', error);
        throw new Error(`Failed to fetch existing issues for duplicate detection: ${error.message}`);
    }
}

export function findDuplicateIssuesInCache(newIssue: ImportedIssue, existingIssues: GiteaIssue[], threshold: number = 0.7): DuplicateMatch[] {
    if (!Array.isArray(existingIssues) || existingIssues.length === 0) {
        return [];
    }

    const duplicates: DuplicateMatch[] = [];

    existingIssues.forEach(existingIssue => {
        const titleSimilarity = calculateStringSimilarity(newIssue.title, existingIssue.title);

        let bodySimilarity = 0;
        if (newIssue.body && existingIssue.body) {
            bodySimilarity = calculateStringSimilarity(newIssue.body, existingIssue.body);
        } else if (!newIssue.body && !existingIssue.body) {
            bodySimilarity = 1.0;
        }

        const combinedScore = titleSimilarity * 0.75 + bodySimilarity * 0.25;

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

    duplicates.sort((a, b) => b.similarity - a.similarity);
    return duplicates;
}

export async function importIssuesInternal(auth: GiteaAuth, repositoryFullName: string, issues: ImportedIssue[], options?: Partial<ImportOptions>): Promise<ImportResults> {
    const [owner, repo] = repositoryFullName.split('/');
    const results: ImportResults = {
        successful: [],
        failed: [],
        skipped: 0,
        duplicates: [],
        duplicateDetectionFailed: false
    };

    let labelMap: Record<string, number> = {};
    let milestoneMap: Record<string, number> = {};
    let validAssignees: Set<string> | null = null;

    const [labelsResult, milestonesResult, collaboratorsResult] = await Promise.allSettled([
        auth.makeRequest(`/api/v1/repos/${owner}/${repo}/labels`) as Promise<Array<{ name: string; id: number }>>,
        auth.makeRequest(`/api/v1/repos/${owner}/${repo}/milestones?limit=50`) as Promise<Array<{ title: string; id: number }>>,
        auth.makeRequest(`/api/v1/repos/${owner}/${repo}/collaborators`) as Promise<Array<{ login: string }>>
    ]);

    if (labelsResult.status === 'fulfilled' && Array.isArray(labelsResult.value)) {
        labelsResult.value.forEach(label => {
            labelMap[label.name.toLowerCase()] = label.id;
        });
    } else {
        console.warn('Failed to fetch labels:', (labelsResult as PromiseRejectedResult).reason);
    }

    if (milestonesResult.status === 'fulfilled' && Array.isArray(milestonesResult.value)) {
        milestonesResult.value.forEach(m => {
            milestoneMap[m.title.toLowerCase()] = m.id;
        });
    } else {
        console.warn('Failed to fetch milestones:', (milestonesResult as PromiseRejectedResult).reason);
    }

    if (collaboratorsResult.status === 'fulfilled' && Array.isArray(collaboratorsResult.value)) {
        validAssignees = new Set(collaboratorsResult.value.map(c => c.login));
    } else {
        console.warn('Failed to fetch collaborators — assignee validation skipped:', (collaboratorsResult as PromiseRejectedResult).reason);
    }

    let existingIssuesCache: GiteaIssue[] = [];
    if (options?.checkDuplicates) {
        try {
            existingIssuesCache = await fetchAllIssues(auth, owner, repo);
        } catch (error: any) {
            console.error('Duplicate detection failed:', error.message);
            results.duplicateDetectionFailed = true;
        }
    }

    for (let i = 0; i < issues.length; i++) {
        const issue = issues[i];
        try {
            if (options?.checkDuplicates && !results.duplicateDetectionFailed && existingIssuesCache.length > 0) {
                const potentialDuplicates = findDuplicateIssuesInCache(
                    issue,
                    existingIssuesCache,
                    options.duplicateThreshold || 0.7
                );

                if (potentialDuplicates.length > 0) {
                    results.duplicates.push({
                        title: issue.title,
                        potentialMatches: potentialDuplicates
                    });
                    results.skipped++;
                    continue;
                }
            }

            const labelIds: number[] = [];
            for (const labelName of (issue.labels || [])) {
                const labelId = labelMap[labelName.toLowerCase()];
                if (labelId) {
                    labelIds.push(labelId);
                }
            }

            const requestBody: {
                title: string;
                body: string;
                labels: number[];
                assignee?: string;
                milestone?: number;
                due_date?: string;
            } = {
                title: issue.title,
                body: issue.body || '',
                labels: labelIds
            };

            if (issue.assignee && options?.allowAssignee) {
                if (validAssignees === null || validAssignees.has(issue.assignee)) {
                    requestBody.assignee = issue.assignee;
                }
            }
            if (issue.milestone && options?.allowMilestone) {
                const milestoneId = milestoneMap[issue.milestone.toLowerCase()];
                if (milestoneId) {
                    requestBody.milestone = milestoneId;
                }
            }
            if (issue.dueDate && options?.allowDueDate) {
                requestBody.due_date = issue.dueDate;
            }

            const result = await auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues`, {
                method: 'POST',
                body: requestBody
            }) as { number: number; html_url: string };

            if (issue.state === 'closed') {
                try {
                    await auth.makeRequest(`/api/v1/repos/${owner}/${repo}/issues/${result.number}`, {
                        method: 'PATCH',
                        body: { state: 'closed' }
                    });
                } catch (closeError: any) {
                    console.warn(`Failed to close imported issue #${result.number}:`, closeError);
                }
            }

            results.successful.push({
                title: issue.title,
                number: result.number,
                url: result.html_url,
                state: issue.state || 'open'
            });
        } catch (error: any) {
            results.failed.push({
                title: issue.title,
                error: error.message
            });
        }
    }

    return results;
}

export async function showImportIssuesDialog(auth: GiteaAuth, repositories: any[]): Promise<void> {
    try {
        const fileUris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: {
                'Excel Files': ['xlsx', 'xls'],
                'All Files': ['*']
            },
            title: 'Select XLSX file to import issues'
        });

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        const filePath = fileUris[0].fsPath;

        if (!repositories || repositories.length === 0) {
            vscode.window.showErrorMessage('No repositories available to import issues into');
            return;
        }

        const repoOptions = repositories.map((repo: any) => ({
            label: repo.full_name,
            description: repo.description || '',
            value: repo.full_name
        }));

        const selectedRepo = await vscode.window.showQuickPick(repoOptions, {
            placeHolder: 'Select repository to import issues into',
            title: 'Import Issues - Select Target Repository'
        });

        if (!selectedRepo) {
            return;
        }

        vscode.window.showInformationMessage('Parsing XLSX file...');
        const issues = parseXlsxFile(filePath);

        if (issues.length === 0) {
            vscode.window.showErrorMessage('No valid issues found in XLSX file');
            return;
        }

        const importOptions = await showImportOptionsDialog(issues);
        if (!importOptions) {
            return;
        }

        const progress = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Importing ${issues.length} issues...`,
            cancellable: false
        }, async () => {
            const results = await importIssuesInternal(auth, selectedRepo.value, issues, importOptions);
            return results;
        });

        showImportResults(progress);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Import failed: ${error.message}`);
        console.error('Import error:', error);
    }
}

export function showImportOptionsDialog(issues: ImportedIssue[]): Promise<ImportOptions | null> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'giteaImportOptions',
            'Import Issues - Options',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        const issuePreview = issues.slice(0, 3).map(issue =>
            `<tr>
                <td>${escapeHtml(issue.title)}</td>
                <td>${issue.labels.length > 0 ? issue.labels.join(', ') : '-'}</td>
                <td>${escapeHtml(issue.body.substring(0, 50))}${issue.body.length > 50 ? '...' : ''}</td>
            </tr>`
        ).join('');

        panel.webview.html = `<!DOCTYPE html>
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
        .container {
            max-width: 600px;
            margin: 0 auto;
        }
        h2 {
            margin-top: 0;
            border-bottom: 1px solid var(--vscode-input-border);
            padding-bottom: 10px;
        }
        .section {
            margin: 20px 0;
            padding: 15px;
            background-color: var(--vscode-editor-inlineValue-background);
            border-left: 3px solid var(--vscode-input-border);
            border-radius: 4px;
        }
        .section h3 {
            margin: 0 0 10px 0;
            font-size: 14px;
            font-weight: 600;
        }
        .option {
            margin: 10px 0;
            display: flex;
            align-items: center;
        }
        input[type="checkbox"] {
            margin-right: 8px;
            cursor: pointer;
        }
        label {
            cursor: pointer;
        }
        .preview {
            margin: 20px 0;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        th, td {
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            text-align: left;
        }
        th {
            background-color: var(--vscode-editor-lineNumberForeground);
            font-weight: 600;
        }
        .buttons {
            margin-top: 20px;
            display: flex;
            gap: 10px;
            justify-content: flex-end;
        }
        button {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 13px;
        }
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .summary {
            font-size: 12px;
            color: var(--vscode-input-foreground);
            margin-bottom: 15px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h2>Import Issues - Options</h2>
        
        <div class="summary">
            Found <strong>${issues.length} issues</strong> to import
        </div>

        <div class="section">
            <h3>Import Options</h3>
            <div class="option">
                <input type="checkbox" id="allowAssignee" name="allowAssignee" checked>
                <label for="allowAssignee">Import assignees (if column present)</label>
            </div>
            <div class="option">
                <input type="checkbox" id="allowMilestone" name="allowMilestone" checked>
                <label for="allowMilestone">Import milestones (if column present)</label>
            </div>
            <div class="option">
                <input type="checkbox" id="allowDueDate" name="allowDueDate" unchecked>
                <label for="allowDueDate">Import due dates (if column present)</label>
            </div>
            <div class="option">
                <input type="checkbox" id="checkDuplicates" name="checkDuplicates" checked>
                <label for="checkDuplicates">Check for duplicate issues (skip similar issues)</label>
            </div>
            <div style="margin-left: 24px; margin-top: 8px;">
                <label for="duplicateThreshold" style="font-size: 12px;">Similarity threshold:</label>
                <select id="duplicateThreshold" style="width: 100%; padding: 6px; margin-top: 4px;">
                    <option value="0.9">Very strict (90%+ match)</option>
                    <option value="0.8">Strict (80%+ match)</option>
                    <option value="0.7" selected>Normal (70%+ match)</option>
                    <option value="0.6">Loose (60%+ match)</option>
                </select>
            </div>
        </div>

        <div class="preview">
            <h3>Preview (first 3 issues)</h3>
            <table>
                <thead>
                    <tr>
                        <th>Title</th>
                        <th>Labels</th>
                        <th>Description</th>
                    </tr>
                </thead>
                <tbody>
                    ${issuePreview}
                </tbody>
            </table>
        </div>

        <div class="buttons">
            <button class="btn-secondary" onclick="cancel()">Cancel</button>
            <button class="btn-primary" onclick="importIssues()">Import Issues</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        document.getElementById('checkDuplicates').addEventListener('change', (e) => {
            document.getElementById('duplicateThreshold').disabled = !e.target.checked;
        });
        
        function importIssues() {
            const options = {
                allowAssignee: document.getElementById('allowAssignee').checked,
                allowMilestone: document.getElementById('allowMilestone').checked,
                allowDueDate: document.getElementById('allowDueDate').checked,
                checkDuplicates: document.getElementById('checkDuplicates').checked,
                duplicateThreshold: parseFloat(document.getElementById('duplicateThreshold').value)
            };
            vscode.postMessage({ command: 'import', options: options });
        }
        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }
    </script>
</body>
</html>`;

        panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'import') {
                resolve(message.options);
            } else {
                resolve(null);
            }
            panel.dispose();
        });

        panel.onDidDispose(() => {
            resolve(null);
        });
    });
}

export function showImportResults(results: ImportResults): void {
    const { successful, failed, skipped, duplicates, duplicateDetectionFailed } = results;

    if (successful.length === 0 && failed.length === 0 && (skipped || 0) === 0) {
        vscode.window.showWarningMessage('No issues were imported');
        return;
    }

    const successMsg = successful.length > 0
        ? `✓ Successfully imported ${successful.length} issue${successful.length !== 1 ? 's' : ''}`
        : '';

    const failMsg = failed.length > 0
        ? `✗ Failed to import ${failed.length} issue${failed.length !== 1 ? 's' : ''}`
        : '';

    const skipMsg = (skipped || 0) > 0
        ? `⊘ Skipped ${skipped} potential duplicate${skipped !== 1 ? 's' : ''}`
        : '';

    const warningMsg = duplicateDetectionFailed
        ? `⚠ Duplicate detection failed - issues may have been imported without duplicate checking`
        : '';

    const message = [successMsg, failMsg, skipMsg, warningMsg].filter(m => m).join('\n');

    const buttons: string[] = [];
    if (successful.length > 0) buttons.push('View Created Issues');
    if (failed.length > 0) buttons.push('View Failures');
    if (duplicates.length > 0) buttons.push('View Duplicates');

    if (failed.length > 0 || duplicates.length > 0 || duplicateDetectionFailed) {
        vscode.window.showWarningMessage(`Import completed!\n\n${message}`, ...buttons).then(choice => {
            if (choice === 'View Created Issues') {
                showCreatedIssues(successful);
            } else if (choice === 'View Failures') {
                showFailureDetails(failed);
            } else if (choice === 'View Duplicates') {
                showDuplicateDetails(duplicates);
            }
        });
    } else if (successful.length > 0) {
        vscode.window.showInformationMessage(`All ${successful.length} issues imported successfully!`, 'View Created Issues').then(choice => {
            if (choice === 'View Created Issues') {
                showCreatedIssues(successful);
            }
        });
    }
}

export function showCreatedIssues(successful: ImportResults['successful']): void {
    const panel = vscode.window.createWebviewPanel(
        'giteaCreatedIssues',
        'Created Issues',
        vscode.ViewColumn.One,
        { enableScripts: false }
    );

    const rows = successful.map(issue => `
        <tr>
            <td><a href="${escapeHtml(issue.url)}">#${issue.number}</a></td>
            <td>${escapeHtml(issue.title)}</td>
            <td>${issue.state === 'closed' ? '<span style="color:#8957e5;">Closed</span>' : '<span style="color:#3fb950;">Open</span>'}</td>
        </tr>
    `).join('');

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background-color: var(--vscode-editor-background); padding: 20px; }
        h2 { margin-top: 0; border-bottom: 1px solid var(--vscode-input-border); padding-bottom: 10px; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { border: 1px solid var(--vscode-input-border); padding: 8px 10px; text-align: left; }
        th { font-weight: 600; }
        a { color: var(--vscode-textLink-foreground); text-decoration: none; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <h2>Created Issues (${successful.length})</h2>
    <table>
        <thead><tr><th>#</th><th>Title</th><th>State</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>
</body>
</html>`;
}

export function showDuplicateDetails(duplicates: ImportResults['duplicates']): void {
    const panel = vscode.window.createWebviewPanel(
        'giteaDuplicates',
        'Duplicate Issues',
        vscode.ViewColumn.One,
        {}
    );

    const duplicateRows = duplicates.map(dup => {
        const matches = dup.potentialMatches.map(match => `
            <div style="margin-top: 8px; padding: 8px; background-color: var(--vscode-editor-inlineValue-background); border-radius: 3px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: 500;">
                        <a href="${match.url}" style="color: var(--vscode-textLink-foreground); text-decoration: none;">
                            #${match.number}: ${escapeHtml(match.title)}
                        </a>
                    </span>
                    <span style="background-color: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 8px; border-radius: 12px; font-size: 12px;">
                        ${match.similarity}% match
                    </span>
                </div>
                <div style="font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px;">
                    State: <strong>${match.state}</strong> | Updated: ${new Date(match.updated_at).toLocaleDateString()}
                </div>
            </div>
        `).join('');

        return `
            <div style="margin-bottom: 20px; padding: 12px; background-color: var(--vscode-panel-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px;">
                <h3 style="margin: 0 0 12px 0; color: var(--vscode-descriptionForeground);">
                    Your Issue:
                </h3>
                <div style="font-weight: 500; margin-bottom: 12px;">
                    ${escapeHtml(dup.title)}
                </div>
                <h3 style="margin: 12px 0 8px 0; color: var(--vscode-descriptionForeground);">
                    Potential Matches:
                </h3>
                ${matches}
            </div>
        `;
    }).join('');

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            line-height: 1.6;
        }
        h2 {
            margin-top: 0;
            border-bottom: 1px solid var(--vscode-input-border);
            padding-bottom: 10px;
        }
        a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        .summary {
            padding: 12px;
            background-color: var(--vscode-editor-inlineValue-background);
            border-left: 3px solid var(--vscode-notificationCenter-border);
            margin-bottom: 20px;
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <h2>Duplicate Issues (${duplicates.length})</h2>
    <div class="summary">
        <strong>${duplicates.length}</strong> issue${duplicates.length !== 1 ? 's' : ''} were skipped due to similarity with existing issues.
        Consider merging or referencing the matched issues instead of creating duplicates.
    </div>
    ${duplicateRows}
</body>
</html>`;
}

export function showFailureDetails(failedIssues: ImportResults['failed']): void {
    const panel = vscode.window.createWebviewPanel(
        'giteaImportFailures',
        'Import Failures',
        vscode.ViewColumn.One,
        {}
    );

    const failureRows = failedIssues.map(issue => `
        <tr>
            <td>${escapeHtml(issue.title)}</td>
            <td>${escapeHtml(issue.error)}</td>
        </tr>
    `).join('');

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
        }
        h2 {
            margin-top: 0;
            border-bottom: 1px solid var(--vscode-input-border);
            padding-bottom: 10px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        th, td {
            border: 1px solid var(--vscode-input-border);
            padding: 10px;
            text-align: left;
        }
        th {
            background-color: var(--vscode-editor-lineNumberForeground);
            font-weight: 600;
        }
        .error-col {
            color: var(--vscode-diffEditor-removedTextForeground);
            font-family: monospace;
            font-size: 11px;
        }
    </style>
</head>
<body>
    <h2>Import Failures (${failedIssues.length})</h2>
    <table>
        <thead>
            <tr>
                <th>Title</th>
                <th>Error</th>
            </tr>
        </thead>
        <tbody>
            ${failureRows}
        </tbody>
    </table>
</body>
</html>`;
}

export function escapeHtml(text: string): string {
    if (!text) return '';
    const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}
