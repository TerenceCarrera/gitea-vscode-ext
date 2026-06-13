const vscode = require('vscode');
const { syncProfileToGitea, restoreProfileFromGitea } = require('../profileSync');
const { setGitUserConfig } = require('../gitUtils');

function registerCommands(context, auth, deps) {
    const { throttledRefresh, giteaStatusBar } = deps;

    const addProfileCommand = vscode.commands.registerCommand('gitea.addProfile', async () => {
        try {
            const added = await auth.addProfile();
            if (added) {
                auth.cache.clear();
                throttledRefresh();

                const activeProfile = auth.activeProfile || 'default';
                giteaStatusBar.text = `$(account) Gitea: ${activeProfile}`;
            }
        } catch (error) {
            console.error('Failed to add profile:', error);
            vscode.window.showErrorMessage(`Failed to add profile: ${error.message}`);
        }
    });

    const switchProfileCommand = vscode.commands.registerCommand('gitea.switchProfile', async () => {
        try {
            const switched = await auth.switchProfile();
            if (switched) {
                auth.cache.clear();
                throttledRefresh();

                const activeProfile = auth.activeProfile || 'default';
                giteaStatusBar.text = `$(account) Gitea: ${activeProfile}`;
            }
        } catch (error) {
            console.error('Failed to switch profile:', error);
            vscode.window.showErrorMessage(`Failed to switch profile: ${error.message}`);
        }
    });

    const removeProfileCommand = vscode.commands.registerCommand('gitea.removeProfile', async () => {
        try {
            await auth.removeProfile();
        } catch (error) {
            console.error('Failed to remove profile:', error);
            vscode.window.showErrorMessage(`Failed to remove profile: ${error.message}`);
        }
    });

    const syncProfileCommand = vscode.commands.registerCommand('gitea.syncProfileToGitea', async () => {
        try {
            await syncProfileToGitea(auth);
        } catch (error) {
            console.error('Failed to sync profile:', error);
            vscode.window.showErrorMessage(`Failed to sync profile: ${error.message}`);
        }
    });

    const restoreProfileCommand = vscode.commands.registerCommand('gitea.restoreProfileFromGitea', async () => {
        try {
            await restoreProfileFromGitea(auth);
        } catch (error) {
            console.error('Failed to restore profile:', error);
            vscode.window.showErrorMessage(`Failed to restore profile: ${error.message}`);
        }
    });

    const setWorkspaceProfileCommand = vscode.commands.registerCommand('gitea.setWorkspaceProfile', async () => {
        try {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
                vscode.window.showInformationMessage('Open a workspace folder first.');
                return;
            }

            const assignedName = auth.getWorkspaceProfile();
            const profiles = auth.listProfiles();

            const items = [
                {
                    label: assignedName ? '$(close) None (clear)' : '$(check) None (clear)',
                    description: 'Do not associate any profile with this workspace',
                    value: null
                },
                ...profiles.map(p => ({
                    label: p.isActive ? `$(check) ${p.name}` : p.name,
                    description: p.url,
                    value: p.name
                }))
            ];

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: assignedName
                    ? `Currently: ${assignedName} — Choose a profile for this workspace`
                    : 'Choose a profile for this workspace'
            });

            if (!selected) return;

            if (selected.value !== assignedName) {
                await auth.setWorkspaceProfile(selected.value);

                if (selected.value) {
                    const profile = auth.listProfiles().find(p => p.name === selected.value);
                    if (profile) {
                        auth.activeProfile = selected.value;
                        auth.instanceUrl = profile.url;
                        auth.authToken = auth.profiles[selected.value].authToken;
                        auth.cache.clear();
                        await auth.saveProfiles();
                        await auth.validateCredentials();
                    }
                }

                const folders = vscode.workspace.workspaceFolders;
                if (folders && selected.value) {
                    const profileData = auth.profiles[selected.value];
                    if (profileData && (profileData.userName || profileData.userEmail)) {
                        setGitUserConfig(
                            folders.map(f => f.uri.fsPath),
                            profileData.userName,
                            profileData.userEmail
                        );
                    }
                }

                throttledRefresh();
                giteaStatusBar.text = selected.value
                    ? `$(account) Gitea: ${selected.value}`
                    : `$(account) Gitea: ${auth.activeProfile || 'default'}`;

                vscode.window.showInformationMessage(
                    selected.value
                        ? `Workspace profile set to "${selected.value}"`
                        : 'Workspace profile cleared'
                );
            }
        } catch (error) {
            console.error('Failed to set workspace profile:', error);
            vscode.window.showErrorMessage(`Failed to set workspace profile: ${error.message}`);
        }
    });

    context.subscriptions.push(
        addProfileCommand,
        switchProfileCommand,
        removeProfileCommand,
        syncProfileCommand,
        restoreProfileCommand,
        setWorkspaceProfileCommand
    );
}

module.exports = { registerCommands };
