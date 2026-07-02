import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Tests', () => {
    test('Extension is Present', function () {
        const extension = vscode.extensions.getExtension('TerenceCarrera.gitea');
        assert.ok(extension, 'Extension not found');
    });

    test('Key Commands are Registered Properly', async function () {
        this.timeout(5000);

        const expectedCommands = [
            'gitea.configure',
            'gitea.addProfile',
            'gitea.switchProfile',
            'gitea.removeProfile',
            'gitea.searchRepositories',
            'gitea.refreshRepositories',
            'gitea.createRepository',
            'gitea.openRepository',
            'gitea.openInBrowser',
            'gitea.searchIssues',
            'gitea.createIssue',
            'gitea.importIssues',
            'gitea.viewIssueDetails',
            'gitea.openIssueInBrowser',
            'gitea.searchPullRequests',
            'gitea.createPullRequest',
            'gitea.viewPullRequestDetails',
            'gitea.openPullRequestInBrowser',
            'gitea.switchBranch',
            'gitea.createBranchFromIssue',
            'gitea.createBranchFromPR',
            'gitea.deleteBranch',
            'gitea.restoreDeletedBranch',
            'gitea.restoreBranchFromReflog',
            'gitea.restoreBranchFromTree',
            'gitea.showDeletedBranchDetails',
            'gitea.removeFromHistory',
            'gitea.clearDeletionHistory',
            'gitea.exportDeletionHistory',
            'gitea.importDeletionHistory',
            'gitea.refreshDeletedBranches',
            'gitea.toggleNotifications',
            'gitea.notificationStatus',
            'gitea.manageStash'
        ];

        for (const cmd of expectedCommands) {
            const commands = await vscode.commands.getCommands();
            assert.ok(commands.includes(cmd), `Command ${cmd} is not registered`);
        }
    });
});
