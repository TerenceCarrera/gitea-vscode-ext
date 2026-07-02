import * as vscode from 'vscode';
import * as reposCommands from './repos';
import * as issuesCommands from './issues';
import * as pullRequestsCommands from './pullRequests';
import * as branchesCommands from './branches';
import * as profilesCommands from './profiles';
import * as notificationsCommands from './notifications';
import * as miscCommands from './misc';
import type { CommandDeps } from '../types';
import GiteaAuth from '../auth';

export function registerAllCommands(context: vscode.ExtensionContext, auth: GiteaAuth, deps: CommandDeps): void {
    reposCommands.registerCommands(context, auth, deps);
    issuesCommands.registerCommands(context, auth, deps);
    pullRequestsCommands.registerCommands(context, auth, deps);
    branchesCommands.registerCommands(context, auth, deps);
    profilesCommands.registerCommands(context, auth, deps);
    notificationsCommands.registerCommands(context, auth, deps);
    miscCommands.registerCommands(context, auth, deps);
}
