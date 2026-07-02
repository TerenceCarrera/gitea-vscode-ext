import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { CacheManager } from './performanceOptimizer';
import { setGitUserConfig } from './gitUtils';
import { GiteaProfiles, ProfileInfo } from './types';

class GiteaAuth {
    instanceUrl: string | null = null;
    authToken: string | null = null;
    activeProfile: string | null = null;
    profiles: GiteaProfiles = {};
    cache: CacheManager<any> = new CacheManager(10000);

    async initialize(): Promise<boolean> {
        try {
            const config = vscode.workspace.getConfiguration('gitea');
            const savedProfiles: GiteaProfiles = (config.get('profiles') as GiteaProfiles) || {};
            this.profiles = savedProfiles;
            const profileName: string = (config.get('activeProfile') as string) || 'default';

            if (this.profiles[profileName]) {
                this.activeProfile = profileName;
                const profile = this.profiles[profileName];
                this.instanceUrl = profile.instanceUrl;
                this.authToken = profile.authToken;
            } else {
                this.instanceUrl = config.get('instanceUrl') || null;
                this.authToken = config.get('authToken') || null;

                if (this.instanceUrl && this.authToken) {
                    this.profiles['default'] = {
                        instanceUrl: this.instanceUrl,
                        authToken: this.authToken
                    };
                    this.activeProfile = 'default';
                    await this.saveProfiles();
                }
            }

            if (!this.instanceUrl || !this.authToken) {
                return false;
            }

            return await this.validateCredentials();
        } catch (error) {
            console.error('Failed to initialize authentication:', error);
            vscode.window.showErrorMessage(`Failed to initialize Gitea authentication: ${(error as Error).message}`);
            return false;
        }
    }

    async validateCredentials(): Promise<boolean> {
        try {
            const user = await this.makeRequest('/api/v1/user');
            if (user && user.login) {
                return true;
            }
            return false;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to Authenticate with Gitea: ${(error as Error).message}`);
            return false;
        }
    }

    async configure(): Promise<void> {
        try {
            const instanceUrl = await vscode.window.showInputBox({
                prompt: 'Enter your Gitea instance URL',
                placeHolder: 'https://gitea.example.com',
                value: this.instanceUrl || '',
                validateInput: (value: string) => {
                    if (!value) return 'Instance URL is required';
                    try {
                        new URL(value);
                        return null;
                    } catch {
                        return 'Please enter a valid URL';
                    }
                }
            });

            if (!instanceUrl) return;

            const authToken = await vscode.window.showInputBox({
                prompt: 'Enter your Personal Access Token',
                placeHolder: 'Your Gitea Personal Access Token',
                password: true,
                validateInput: (value: string) => {
                    if (!value) return 'Token is required';
                    return null;
                }
            });

            if (!authToken) return;

            const profileName = await vscode.window.showInputBox({
                prompt: 'Enter a profile name',
                placeHolder: 'e.g., work, personal, default',
                value: this.activeProfile || 'default',
                validateInput: (value: string) => {
                    if (!value) return 'Profile name is required';
                    return null;
                }
            });

            if (!profileName) return;

            const userName = await vscode.window.showInputBox({
                prompt: 'Git user.name for commits (optional — leave blank to skip)',
                placeHolder: 'e.g., John Doe',
                value: this.profiles[profileName]?.userName || ''
            });

            if (userName === undefined) return;

            const userEmail = await vscode.window.showInputBox({
                prompt: 'Git user.email for commits (optional — leave blank to skip)',
                placeHolder: 'e.g., john@example.com',
                value: this.profiles[profileName]?.userEmail || ''
            });

            if (userEmail === undefined) return;

            this.profiles[profileName] = {
                instanceUrl: instanceUrl,
                authToken: authToken,
                userName: userName || undefined,
                userEmail: userEmail || undefined
            };
            this.activeProfile = profileName;
            this.instanceUrl = instanceUrl;
            this.authToken = authToken;

            await this.saveProfiles();
            await this.validateCredentials();
        } catch (error) {
            console.error('Failed to configure Gitea:', error);
            vscode.window.showErrorMessage(`Failed to configure Gitea: ${(error as Error).message}`);
        }
    }

    async addProfile(): Promise<boolean> {
        try {
            const instanceUrl = await vscode.window.showInputBox({
                prompt: 'Enter your Gitea instance URL',
                placeHolder: 'https://gitea.example.com',
                validateInput: (value: string) => {
                    if (!value) return 'Instance URL is required';
                    try {
                        new URL(value);
                        return null;
                    } catch {
                        return 'Please enter a valid URL';
                    }
                }
            });

            if (!instanceUrl) return false;

            const authToken = await vscode.window.showInputBox({
                prompt: 'Enter your Personal Access Token',
                placeHolder: 'Your Gitea Personal Access Token',
                password: true,
                validateInput: (value: string) => {
                    if (!value) return 'Token is required';
                    return null;
                }
            });

            if (!authToken) return false;

            const profileName = await vscode.window.showInputBox({
                prompt: 'Enter a profile name',
                placeHolder: 'e.g., work, personal, main',
                validateInput: (value: string) => {
                    if (!value) return 'Profile name is required';
                    if (this.profiles[value]) return `Profile "${value}" already exists`;
                    return null;
                }
            });

            if (!profileName) return false;

            const userName = await vscode.window.showInputBox({
                prompt: 'Git user.name for commits (optional — leave blank to skip)',
                placeHolder: 'e.g., John Doe'
            });

            if (userName === undefined) return false;

            const userEmail = await vscode.window.showInputBox({
                prompt: 'Git user.email for commits (optional — leave blank to skip)',
                placeHolder: 'e.g., john@example.com'
            });

            if (userEmail === undefined) return false;

            this.profiles[profileName] = {
                instanceUrl: instanceUrl,
                authToken: authToken,
                userName: userName || undefined,
                userEmail: userEmail || undefined
            };

            await this.saveProfiles();

            const switchNow = await vscode.window.showInformationMessage(
                `Profile "${profileName}" created successfully. Switch to it now?`,
                'Switch', 'Keep Current'
            );

            if (switchNow === 'Switch') {
                this.activeProfile = profileName;
                this.instanceUrl = instanceUrl;
                this.authToken = authToken;
                await this.saveProfiles();
                await this.validateCredentials();
            }

            return true;
        } catch (error) {
            console.error('Failed to add profile:', error);
            vscode.window.showErrorMessage(`Failed to add profile: ${(error as Error).message}`);
            return false;
        }
    }

    async saveProfiles(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gitea');
            await config.update('profiles', this.profiles, vscode.ConfigurationTarget.Global);
            await config.update('activeProfile', this.activeProfile, vscode.ConfigurationTarget.Global);
        } catch (error) {
            console.error('Failed to save profiles:', error);
            throw error;
        }
    }

    async switchProfile(): Promise<boolean> {
        try {
            const config = vscode.workspace.getConfiguration('gitea');
            const savedProfiles: GiteaProfiles = config.get('profiles') || {};
            this.profiles = savedProfiles;

            const profileNames = Object.keys(this.profiles);

            if (profileNames.length === 0) {
                vscode.window.showInformationMessage('No profiles configured. Please configure one first.');
                return false;
            }

            const selected = await vscode.window.showQuickPick(
                profileNames.map(name => ({
                    label: this.activeProfile === name ? `$(check) ${name}` : name,
                    description: this.profiles[name].instanceUrl,
                    profileName: name
                })),
                { placeHolder: 'Select a profile' }
            );

            if (!selected) return false;

            if (selected.profileName === this.activeProfile) {
                vscode.window.showInformationMessage(`Already on Profile: ${selected.profileName}`);
                return false;
            }

            this.activeProfile = selected.profileName;
            const profile = this.profiles[this.activeProfile];
            if (!profile) {
                vscode.window.showErrorMessage(`Profile "${this.activeProfile}" not found.`);
                return false;
            }
            this.instanceUrl = profile.instanceUrl;
            this.authToken = profile.authToken;

            await this.saveProfiles();
            await this.validateCredentials();
            return true;
        } catch (error) {
            console.error('Failed to switch profile:', error);
            vscode.window.showErrorMessage(`Failed to switch profile: ${(error as Error).message}`);
            return false;
        }
    }

    listProfiles(): ProfileInfo[] {
        const config = vscode.workspace.getConfiguration('gitea');
        const savedProfiles: GiteaProfiles = config.get('profiles') || {};
        this.profiles = savedProfiles;

        return Object.keys(this.profiles).map(name => ({
            name: name,
            url: this.profiles[name].instanceUrl,
            isActive: this.activeProfile === name
        }));
    }

    async removeProfile(profileName?: string | null): Promise<boolean> {
        try {
            const config = vscode.workspace.getConfiguration('gitea');
            const savedProfiles: GiteaProfiles = config.get('profiles') || {};
            this.profiles = savedProfiles;

            if (!profileName) {
                const profileNames = Object.keys(this.profiles);

                if (profileNames.length === 0) {
                    vscode.window.showInformationMessage('No profiles to remove');
                    return false;
                }

                const selected = await vscode.window.showQuickPick(
                    profileNames.map(name => ({
                        label: name,
                        description: this.profiles[name].instanceUrl,
                        profileName: name
                    })),
                    { placeHolder: 'Select a profile to remove' }
                );

                if (!selected) return false;
                profileName = selected.profileName;
            }

            if (profileName === this.activeProfile) {
                vscode.window.showErrorMessage('Cannot remove the active profile. Switch to another profile first.');
                return false;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to remove the profile "${profileName}"?`,
                'Remove', 'Cancel'
            );

            if (confirm !== 'Remove') return false;

            delete this.profiles[profileName];
            await this.saveProfiles();
            vscode.window.showInformationMessage(`Profile "${profileName}" removed successfully`);
            return true;
        } catch (error) {
            console.error('Failed to remove profile:', error);
            vscode.window.showErrorMessage(`Failed to remove profile: ${(error as Error).message}`);
            return false;
        }
    }

    makeRequest(endpoint: string, options: { method?: string; body?: any; headers?: Record<string, string> } = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.instanceUrl || !this.authToken) {
                reject(new Error('Gitea not configured. Please run "Gitea: Configure Instance"'));
                return;
            }

            const method = options.method || 'GET';

            const fetchAllPages = (
                endpoint: string,
                options: { method?: string; body?: any; headers?: Record<string, string> },
                page: number = 1,
                accumulated: any[] = []
            ): void => {
                let pagedEndpoint = endpoint;
                if (endpoint.includes('?')) {
                    pagedEndpoint += `&page=${page}`;
                } else {
                    pagedEndpoint += `?page=${page}`;
                }

                const url = new URL(pagedEndpoint, this.instanceUrl!);
                const protocol = url.protocol === 'https:' ? https : http;

                const requestOptions: https.RequestOptions = {
                    method: method,
                    headers: {
                        'Authorization': `token ${this.authToken!}`,
                        'Content-Type': 'application/json',
                        ...options.headers
                    }
                };

                const req = protocol.request(url, requestOptions, (res) => {
                    let data = '';

                    res.on('data', (chunk) => {
                        data += chunk;
                    });

                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            let parsed: any;
                            try {
                                parsed = JSON.parse(data);
                            } catch {
                                resolve(data);
                                return;
                            }

                            if (method === 'GET' && Array.isArray(parsed) && res.headers['x-total-count']) {
                                const total = parseInt(res.headers['x-total-count'] as string, 10);
                                const currentCount = accumulated.length + parsed.length;
                                const allData = accumulated.concat(parsed);
                                if (currentCount < total) {
                                    fetchAllPages(endpoint, options, page + 1, allData);
                                    return;
                                } else {
                                    const cacheKey = `${this.instanceUrl!}${endpoint}`;
                                    this.cache.set(cacheKey, allData);
                                    resolve(allData);
                                    return;
                                }
                            } else {
                                if (method === 'GET') {
                                    const cacheKey = `${this.instanceUrl!}${endpoint}`;
                                    this.cache.set(cacheKey, parsed);
                                }
                                resolve(parsed);
                                return;
                            }
                        } else {
                            const errorBody = data.length > 200 ? data.substring(0, 200) + '…' : data;
                            reject(new Error(`API request failed with status ${res.statusCode}: ${errorBody}`));
                        }
                    });
                });

                req.on('error', (error) => {
                    reject(error);
                });

                if (options.body) {
                    req.write(JSON.stringify(options.body));
                }

                req.end();
            };

            if (method === 'GET') {
                const cacheKey = `${this.instanceUrl}${endpoint}`;
                const cached = this.cache.get(cacheKey);
                if (cached) {
                    resolve(cached);
                    return;
                }
            }

            fetchAllPages(endpoint, options);
        });
    }

    fetchBinary(url: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            if (!this.authToken) {
                reject(new Error('Gitea not configured'));
                return;
            }
            let parsedUrl: URL;
            try {
                parsedUrl = new URL(url);
            } catch (e) {
                reject(e);
                return;
            }
            const protocol = parsedUrl.protocol === 'https:' ? https : http;
            const requestOptions: https.RequestOptions = {
                method: 'GET',
                headers: { 'Authorization': `token ${this.authToken}` }
            };
            const req = protocol.request(parsedUrl, requestOptions, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(Buffer.concat(chunks));
                    } else {
                        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
                    }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

    isConfigured(): boolean {
        return !!(this.instanceUrl && this.authToken);
    }

    getWorkspaceProfile(): string | null {
        try {
            const config = vscode.workspace.getConfiguration('gitea');
            return config.get('workspaceProfile', null);
        } catch {
            return null;
        }
    }

    async setWorkspaceProfile(profileName: string | null): Promise<void> {
        const config = vscode.workspace.getConfiguration('gitea');
        await config.update('workspaceProfile', profileName, vscode.ConfigurationTarget.Workspace);
    }

    async applyWorkspaceProfile(): Promise<string | null> {
        const assignedName = this.getWorkspaceProfile();
        if (!assignedName) return null;

        const profile = this.profiles[assignedName];
        if (!profile) return null;

        if (assignedName === this.activeProfile) return null;

        this.activeProfile = assignedName;
        this.instanceUrl = profile.instanceUrl;
        this.authToken = profile.authToken;
        this.cache.clear();
        await this.saveProfiles();

        if (profile.userName || profile.userEmail) {
            const folders = vscode.workspace.workspaceFolders;
            if (folders) {
                setGitUserConfig(
                    folders.map(f => f.uri.fsPath),
                    profile.userName,
                    profile.userEmail
                );
            }
        }

        return assignedName;
    }
}

export default GiteaAuth;
