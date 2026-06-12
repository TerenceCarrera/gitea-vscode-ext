const vscode = require('vscode');
const https = require('https');
const http = require('http');
const { CacheManager } = require('./performanceOptimizer');
const { setGitUserConfig } = require('./gitUtils');

class GiteaAuth {
    constructor() {
        this.instanceUrl = null;
        this.authToken = null;
        this.activeProfile = null;
        this.profiles = {};
        this.cache = new CacheManager(10000); // 10 second TTL for API cache
    }

    /**
     * Initialize authentication from VS Code settings
     */
    async initialize() {
        try {
            const config = vscode.workspace.getConfiguration('gitea');

            // Load profiles
            const savedProfiles = config.get('profiles') || {};
            this.profiles = savedProfiles;

            // Get active profile name
            const profileName = config.get('activeProfile') || 'default';

            // Load active profile
            if (this.profiles[profileName]) {
                this.activeProfile = profileName;
                const profile = this.profiles[profileName];
                this.instanceUrl = profile.instanceUrl;
                this.authToken = profile.authToken;
            } else {
            // Try legacy configuration for backward compatibility
                this.instanceUrl = config.get('instanceUrl');
                this.authToken = config.get('authToken');

                if (this.instanceUrl && this.authToken) {
                    // Migrate to profile-based system
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
            vscode.window.showErrorMessage(`Failed to initialize Gitea authentication: ${error.message}`);
            return false;
        }
    }

    /**
     * Validate credentials by making a test API call
     */
    async validateCredentials() {
        try {
            const user = await this.makeRequest('/api/v1/user');
            if (user && user.login) {
                return true;
            }
            return false;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to Authenticate with Gitea: ${error.message}`);
            return false;
        }
    }

    /**
     * Configure Gitea instance and authentication
     */
    async configure() {
        try {
            // Get instance URL
            const instanceUrl = await vscode.window.showInputBox({
                prompt: 'Enter your Gitea instance URL',
                placeHolder: 'https://gitea.example.com',
                value: this.instanceUrl || '',
                validateInput: (value) => {
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

            // Get auth token
            const authToken = await vscode.window.showInputBox({
                prompt: 'Enter your Personal Access Token',
                placeHolder: 'Your Gitea Personal Access Token',
                password: true,
                validateInput: (value) => {
                    if (!value) return 'Token is required';
                    return null;
                }
            });

            if (!authToken) return;

            // Get profile name
            const profileName = await vscode.window.showInputBox({
                prompt: 'Enter a profile name',
                placeHolder: 'e.g., work, personal, default',
                value: this.activeProfile || 'default',
                validateInput: (value) => {
                    if (!value) return 'Profile name is required';
                    return null;
                }
            });

            if (!profileName) return;

            // Get git user name (optional)
            const userName = await vscode.window.showInputBox({
                prompt: 'Git user.name for commits (optional — leave blank to skip)',
                placeHolder: 'e.g., John Doe',
                value: this.profiles[profileName]?.userName || ''
            });

            if (userName === undefined) return;

            // Get git user email (optional)
            const userEmail = await vscode.window.showInputBox({
                prompt: 'Git user.email for commits (optional — leave blank to skip)',
                placeHolder: 'e.g., john@example.com',
                value: this.profiles[profileName]?.userEmail || ''
            });

            if (userEmail === undefined) return;

            // Save profile
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

            // Validate
            await this.validateCredentials();
        } catch (error) {
            console.error('Failed to configure Gitea:', error);
            vscode.window.showErrorMessage(`Failed to configure Gitea: ${error.message}`);
        }
    }

    /**
     * Add a new profile
     */
    async addProfile() {
        try {
            // Get instance URL
            const instanceUrl = await vscode.window.showInputBox({
                prompt: 'Enter your Gitea instance URL',
                placeHolder: 'https://gitea.example.com',
                validateInput: (value) => {
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

            // Get auth token
            const authToken = await vscode.window.showInputBox({
                prompt: 'Enter your Personal Access Token',
                placeHolder: 'Your Gitea Personal Access Token',
                password: true,
                validateInput: (value) => {
                    if (!value) return 'Token is required';
                    return null;
                }
            });

            if (!authToken) return false;

            // Get profile name
            const profileName = await vscode.window.showInputBox({
                prompt: 'Enter a profile name',
                placeHolder: 'e.g., work, personal, main',
                validateInput: (value) => {
                    if (!value) return 'Profile name is required';
                    if (this.profiles[value]) return `Profile "${value}" already exists`;
                    return null;
                }
            });

            if (!profileName) return false;

            // Get git user name (optional)
            const userName = await vscode.window.showInputBox({
                prompt: 'Git user.name for commits (optional — leave blank to skip)',
                placeHolder: 'e.g., John Doe'
            });

            if (userName === undefined) return false;

            // Get git user email (optional)
            const userEmail = await vscode.window.showInputBox({
                prompt: 'Git user.email for commits (optional — leave blank to skip)',
                placeHolder: 'e.g., john@example.com'
            });

            if (userEmail === undefined) return false;

            // Save profile
            this.profiles[profileName] = {
                instanceUrl: instanceUrl,
                authToken: authToken,
                userName: userName || undefined,
                userEmail: userEmail || undefined
            };

            await this.saveProfiles();

            // Ask if user wants to switch to this profile
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
            vscode.window.showErrorMessage(`Failed to add profile: ${error.message}`);
            return false;
        }
    }

    /**
     * Save profiles to VS Code settings
     */
    async saveProfiles() {
        try {
            const config = vscode.workspace.getConfiguration('gitea');
            await config.update('profiles', this.profiles, vscode.ConfigurationTarget.Global);
            await config.update('activeProfile', this.activeProfile, vscode.ConfigurationTarget.Global);
        } catch (error) {
            console.error('Failed to save profiles:', error);
            throw error;
        }
    }

    /**
     * Switch to a different profile (list and switch combined)
     */
    async switchProfile() {
        try {
            // Reload profiles from settings to ensure we have the latest
            const config = vscode.workspace.getConfiguration('gitea');
            const savedProfiles = config.get('profiles') || {};
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

            // If same profile is selected, just return
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
            vscode.window.showErrorMessage(`Failed to switch profile: ${error.message}`);
            return false;
        }
    }

    /**
     * List all available profiles (returns array for programmatic access)
     */
    listProfiles() {
        // Reload profiles from settings to ensure we have the latest
        const config = vscode.workspace.getConfiguration('gitea');
        const savedProfiles = config.get('profiles') || {};
        this.profiles = savedProfiles;

        return Object.keys(this.profiles).map(name => ({
            name: name,
            url: this.profiles[name].instanceUrl,
            isActive: this.activeProfile === name
        }));
    }

    /**
     * Remove a profile
     */
    async removeProfile(profileName = null) {
        try {
            // Reload profiles from settings to ensure we have the latest
            const config = vscode.workspace.getConfiguration('gitea');
            const savedProfiles = config.get('profiles') || {};
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
            vscode.window.showErrorMessage(`Failed to remove profile: ${error.message}`);
            return false;
        }
    }

    /**
     * Make an authenticated request to the Gitea API
     * @param {string} endpoint - API endpoint (e.g., '/api/v1/user')
     * @param {object} options - Request options
     */
    makeRequest(endpoint, options = {}) {
        return new Promise((resolve, reject) => {
            if (!this.instanceUrl || !this.authToken) {
                reject(new Error('Gitea not configured. Please run "Gitea: Configure Instance"'));
                return;
            }

            const method = options.method || 'GET';
            // Internal function to handle pagination
            const fetchAllPages = (endpoint, options, page = 1, accumulated = []) => {
                // Build endpoint with page parameter if needed
                let pagedEndpoint = endpoint;
                if (endpoint.includes('?')) {
                    pagedEndpoint += `&page=${page}`;
                } else {
                    pagedEndpoint += `?page=${page}`;
                }

                const url = new URL(pagedEndpoint, this.instanceUrl);
                const protocol = url.protocol === 'https:' ? https : http;

                const requestOptions = {
                    method: method,
                    headers: {
                        'Authorization': `token ${this.authToken}`,
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
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            let parsed;
                            try {
                                parsed = JSON.parse(data);
                            } catch (e) {
                                void(e);
                                resolve(data);
                                return;
                            }

                            // Handle pagination only for GET and array data
                            if (method === 'GET' && Array.isArray(parsed) && res.headers['x-total-count']) {
                                const total = parseInt(res.headers['x-total-count'], 10);
                                const currentCount = accumulated.length + parsed.length;
                                const allData = accumulated.concat(parsed);
                                if (currentCount < total) {
                                    // Request next page
                                    fetchAllPages(endpoint, options, page + 1, allData);
                                    return;
                                } else {
                                    // Cache only if all data has been collected
                                    const cacheKey = `${this.instanceUrl}${endpoint}`;
                                    this.cache.set(cacheKey, allData);
                                    resolve(allData);
                                    return;
                                }
                            } else {
                                // Cache GET responses (not paginated)
                                if (method === 'GET') {
                                    const cacheKey = `${this.instanceUrl}${endpoint}`;
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

            // Check cache for GET requests (safe to cache)
            if (method === 'GET') {
                const cacheKey = `${this.instanceUrl}${endpoint}`;
                const cached = this.cache.get(cacheKey);
                if (cached) {
                    resolve(cached);
                    return;
                }
            }

            // Start the request (with pagination if needed)
            fetchAllPages(endpoint, options);
        });
    }

    /**
     * Fetch a URL with authentication and return a Buffer of the response body.
     * Unlike makeRequest, this does NOT parse the response as JSON and works for
     * any URL (not just /api/v1 endpoints), making it suitable for fetching
     * binary assets such as issue attachments and embedded images.
     *
     * @param {string} url  Absolute URL to fetch
     * @returns {Promise<Buffer>}
     */
    fetchBinary(url) {
        return new Promise((resolve, reject) => {
            if (!this.authToken) {
                reject(new Error('Gitea not configured'));
                return;
            }
            let parsedUrl;
            try {
                parsedUrl = new URL(url);
            } catch (e) {
                reject(e);
                return;
            }
            const protocol = parsedUrl.protocol === 'https:' ? https : http;
            const requestOptions = {
                method: 'GET',
                headers: { 'Authorization': `token ${this.authToken}` }
            };
            const req = protocol.request(parsedUrl, requestOptions, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
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

    /**
     * Check if authentication is configured
     */
    isConfigured() {
        return !!(this.instanceUrl && this.authToken);
    }

    /**
     * Get the profile name assigned to the current workspace (from workspace settings).
     * @returns {string|null}
     */
    getWorkspaceProfile() {
        try {
            const config = vscode.workspace.getConfiguration('gitea');
            return config.get('workspaceProfile', null);
        } catch {
            return null;
        }
    }

    /**
     * Assign a profile name to the current workspace (saves to workspace settings).
     * Pass null to clear the assignment.
     * @param {string|null} profileName
     */
    async setWorkspaceProfile(profileName) {
        const config = vscode.workspace.getConfiguration('gitea');
        await config.update('workspaceProfile', profileName, vscode.ConfigurationTarget.Workspace);
    }

    /**
     * If the current workspace has a profile assigned via workspace settings,
     * switch to it silently (if it differs from the active profile).
     * @returns {Promise<string|null>} The profile name switched to, or null
     */
    async applyWorkspaceProfile() {
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

module.exports = GiteaAuth;
