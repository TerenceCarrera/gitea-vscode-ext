import * as vscode from 'vscode';
import type { CommandDeps } from '../types';
import GiteaAuth from '../auth';

export function registerCommands(context: vscode.ExtensionContext, auth: GiteaAuth, deps: CommandDeps): void {
    const { stashManager, versionInfoProvider } = deps;

    const manageStashCommand = vscode.commands.registerCommand('gitea.manageStash', async () => {
        try {
            await stashManager.manageStashes();
        } catch (error) {
            console.error('Failed to manage stashes:', error);
            vscode.window.showErrorMessage(`Failed to manage stashes: ${error.message}`);
        }
    });

    const showVersionInfoCommand = vscode.commands.registerCommand('gitea.showVersionInfo', async () => {
        try {
            await versionInfoProvider.show();
        } catch (error) {
            console.error('Failed to show version info:', error);
            vscode.window.showErrorMessage(`Failed to show version info: ${error.message}`);
        }
    });

    context.subscriptions.push(
        manageStashCommand,
        showVersionInfoCommand
    );
}
