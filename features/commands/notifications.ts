import * as vscode from 'vscode';
import type { CommandDeps } from '../types';
import GiteaAuth from '../auth';

export function registerCommands(context: vscode.ExtensionContext, auth: GiteaAuth, deps: CommandDeps): void {
    const { getNotificationManager } = deps;

    const toggleNotificationsCommand = vscode.commands.registerCommand('gitea.toggleNotifications', async () => {
        try {
            if (!auth.isConfigured()) {
                vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
                return;
            }
            await getNotificationManager().toggleMonitoring();
        } catch (error) {
            console.error('Failed to toggle notifications:', error);
            vscode.window.showErrorMessage(`Failed to toggle notifications: ${error.message}`);
        }
    });

    const notificationStatusCommand = vscode.commands.registerCommand('gitea.notificationStatus', () => {
        try {
            const status = getNotificationManager().getStatus();
            const message = status.isMonitoring
                ? `Notifications enabled (polling every ${status.pollInterval / 1000}s)`
                : 'Notifications disabled';
            vscode.window.showInformationMessage(message);
        } catch (error) {
            console.error('Failed to get notification status:', error);
            vscode.window.showErrorMessage(`Failed to get notification status: ${error.message}`);
        }
    });

    context.subscriptions.push(
        toggleNotificationsCommand,
        notificationStatusCommand
    );
}
