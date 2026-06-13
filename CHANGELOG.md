# Changelog

All notable changes to this project are documented in this file.
This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.3.1] - 2026-06-13

### Fixed

- **`allRepos.map is not a function` crash in tree providers** (issue [#20](https://github.com/terence-carrera/gitea-vscode/issues/20)): `filterRepositoriesByWorkspace` now guards against non-array `allRepos` values returned by the API client when the server response is not a JSON array (e.g., HTML error page, JSON error object, or unexpected format). The tree views (Repositories, Issues, Pull Requests) degrade gracefully instead of failing with `allRepos.map is not a function`.

## [0.3.0] - 2026-06-13

### Added

- **Workspace profile binding**: assign a Gitea profile to the current workspace via `Gitea: Set Workspace Profile`. The profile is saved in `.vscode/settings.json` and auto-applied on re-open.
- **Git identity per profile**: profiles now have optional `userName` and `userEmail` fields. When a workspace profile is set, the extension runs `git config user.name` / `user.email` (local) in every workspace git repo so commits use the right identity automatically.

### Changed

- **Extension architecture**: refactored inline command handlers into dedicated modules under `features/commands/`. `extension.js` reduced from ~1143 to ~177 lines.
- **Shared git utilities**: extracted `findGitReposInDir`, `resolveGitConfigPath`, `getRepoScanDepth` into `features/gitUtils.js` — used by both tree providers and branch management.
- **Notification deduplication**: `filterRepositoriesByWorkspace` now imported from `treeProviders.js` instead of having a separate implementation in `notifications.js`.
- **Documentation**: simplified all docs; removed internal architecture notes and scaffold template.

### Fixed

- **Cache TTL**: `CacheManager` in `auth.js` was initialized with 1000ms (1s) instead of the documented 10000ms (10s).
- **Removed orphaned `helloWorld` command registration**.

## [0.2.1] - 2026-05-02

### Added

- **VS Code profile sync to Gitea** (issue [#18](https://github.com/terence-carrera/gitea-vscode/issues/18)): sync and restore your VS Code profile (settings, keybindings, extensions) using any Gitea repository as a backend.
  - `gitea.syncProfileToGitea`: uploads `settings.json`, `keybindings.json`, and an `extensions.json` snapshot to a user-chosen Gitea repository (defaults to `<you>/vscode-profile`; creates it as private if missing).
  - `gitea.restoreProfileFromGitea`: downloads profile files from Gitea, writes settings and keybindings back to the VS Code user-data directory, and offers to install any missing extensions.
  - Repository picker with free-text fallback so you can target any owned repo.
  - Progress notifications during upload/download and a "Reload Window" prompt after restore.

### Fixed

- **Images in issue / PR webviews returning HTTP 403** (issue [#19](https://github.com/terence-carrera/gitea-vscode/issues/19)): Gitea attachment and embedded images now render correctly.
  - Added `embedGiteaImages()` helper that fetches each Gitea-hosted `<img>` with the authentication token server-side and replaces the `src` attribute with an inline `data:` URI before the HTML is handed to the webview.
  - Applied to all three webview HTML render paths: `showPullRequest`, `showIssue`, and `_refreshPanel`.
- **Git worktree directories not recognized as repositories** (issue [#17](https://github.com/terence-carrera/gitea-vscode/issues/17)): the workspace repository scanner now resolves `commondir` in worktree git dirs so the main repo's remote configuration is found correctly.
- **`getContrastColor is not a function`** when opening a pull request that has labels: added the missing `getContrastColor` method to `PullRequestWebviewProvider` (it previously only existed in `IssueWebviewProvider`).

## [0.1.8] - 2026-01-21

### Fixed

- **Issue import duplicate detection**: fixed silent failure when API calls to fetch existing issues fail during duplicate detection.
  - Error propagation: `fetchAllIssues()` now throws errors instead of returning empty array on failure.
  - Graceful degradation: import continues but displays warning when duplicate detection fails: `⚠ Duplicate detection failed - issues may have been imported without duplicate checking`.
  - User notification: users are now informed when duplicate checking couldn't be performed, preventing silent data quality issues.

## [0.1.7] - 2026-01-17

### Added

- API client: `makeRequest()` now supports automatic pagination for GET list endpoints when the server provides `X-Total-Count`. Thanks [@ale-argo](https://github.com/ale-argo).

## [0.1.6] - 2026-01-12

### Added

- **Import Issues from XLSX**: bulk import issues from Excel files with automatic label mapping and error reporting.
  - Support for Excel XLSX format with flexible column naming (case-insensitive).
  - Required column: Title; optional columns: Description, Labels, Assignee, Milestone, Priority, Due Date.
  - Automatic label name to ID mapping - labels must exist in target repository.
  - Interactive import options dialog with preview of first 3 issues.
  - **Duplicate detection**: intelligent duplicate checking using similarity scoring to prevent redundant issue creation.
    - Compares new issues against existing repository issues using title and description similarity.
    - Levenshtein distance algorithm calculates combined similarity score (75% title, 25% description).
    - **Pagination support**: fetches all repository issues regardless of count (not limited to first 100).
    - **Optimized for bulk imports**: pre-fetches all existing issues once before processing to minimize API calls.
    - **Improved body handling**: intelligently treats missing descriptions - issues with no body are considered matching on body criteria.
    - Configurable similarity threshold: Very strict (90%), Strict (80%), Normal (70%), or Loose (60%).
    - Automatically skips issues that match existing ones above the threshold.
    - Detailed duplicate report shows matched issues with similarity percentage, state, and update timestamp.
    - Interactive duplicate viewer with links to matched issues for manual review.
  - Import progress tracking with detailed success/failure reporting.
  - Comprehensive error handling with detailed failure information for troubleshooting.
  - `gitea.importIssues` command: import issues from XLSX file into selected repository.
  - Archive icon button in Issues view for easy access to import functionality.
  - Full documentation in [docs/IMPORT_ISSUES_FEATURE.md](docs/IMPORT_ISSUES_FEATURE.md).
- **Personal Access Token documentation**: added detailed token permission requirements to README.md.
  - Specifies required Read & Write permissions: Repository, Issue, Pull Request.
  - Specifies required Read Only permissions: Notification, User.
  - Helps users configure tokens correctly for all extension features.

## [0.1.5] - 2026-01-11

### Changed

- **Status bar icon**: now uses `$(account)` icon for better visual consistency with VS Code.
- **Status bar color**: removed custom color to respect user's theme preferences.

## [0.1.4] - 2026-01-11

### Added

- **Branch deletion tracking & restoration**: comprehensive branch management system with deletion history and recovery capabilities.
- **Deleted Branches view**: dedicated tree view showing all tracked deleted branches organized by repository with timestamps.
- **Persistent deletion tracking**: branch deletion history saved across VS Code sessions using globalState storage.
- **VS Code Settings Sync integration**: deletion history automatically syncs across all machines when VS Code Settings Sync is enabled - no external services required.
- **Enhanced reflog parsing**: improved detection of branch deletions with support for multiple deletion patterns (standard delete, force delete, remote branch deletion, update-ref deletions).
- **Visual diff preview before restoration**: review changed files and see detailed diffs before restoring a deleted branch.
- **Interactive file diff viewer**: click on individual files in the preview to see side-by-side diffs.
- **Export/import deletion history**: save deletion tracking data to JSON files for backup, archival, or transfer between machines.
- **Configurable retention period**: set how long to keep deleted branch history with `gitea.branchDeletionRetentionDays` setting (1-365 days, default: 90 days).
- **Deletion history timeline**: view when branches were deleted with human-readable relative timestamps (e.g., "2 days ago", "5 hours ago").
- **Deletion source tracking**: identifies whether a branch was deleted through the extension or detected via Git reflog.
- Commands:
  - `gitea.deleteBranch`: delete branches with normal or force delete options while tracking the deletion.
  - `gitea.restoreDeletedBranch`: restore recently deleted branches from the extension's tracked history.
  - `gitea.restoreBranchFromReflog`: scan Git reflog to find and restore branches deleted outside the extension.
  - `gitea.showDeletedBranchDetails`: view detailed information about a deleted branch with preview & restore options.
  - `gitea.restoreBranchFromTree`: restore a branch directly from the Deleted Branches tree view.
  - `gitea.removeFromHistory`: remove a specific branch from deletion history.
  - `gitea.clearDeletionHistory`: clear all tracked deletion history.
  - `gitea.refreshDeletedBranches`: manually refresh the deleted branches view.
  - `gitea.exportDeletionHistory`: export deletion history to a JSON file.
  - `gitea.importDeletionHistory`: import deletion history from a JSON file with merge or replace strategies.

### Changed

- Branch deletion now automatically tracks deletions for potential restoration.
- Deletion history persists across VS Code restarts and syncs via Settings Sync when enabled.

## [0.1.3] - 2026-01-10

### Added

- Branch switching/checkout: switch between branches in your repository with a quick picker.
- Quick branch creation from Issues: create a new branch directly from an issue with auto-generated branch names.
- Quick branch creation from Pull Requests: create a new branch from PR details with branch base selection.
- Branch context menu actions: right-click on issues and PRs to create branches.
- Create Branch buttons in Issue and PR detail panels for easy branch creation workflow.
- `gitea.switchBranch` command: switch branches from the command palette.
- `gitea.createBranchFromIssue` command: create a branch linked to an issue.
- `gitea.createBranchFromPR` command: create a branch linked to a pull request.
- Contributing section in README with contribution guidelines, development setup, and issue reporting instructions.
- Markdown rendering support: PR and Issue descriptions and comments now render with full markdown formatting including headings, code blocks, blockquotes, and links.
- Inline code review with diff views: view file changes directly in PR detail panels with syntax-highlighted diffs showing additions, deletions, and context.
- Collapsible file diff viewer: click file headers to expand/collapse individual file diffs for easier navigation.
- Stash management integration: manage git stashes with support for creating, applying, popping, dropping, and viewing stashes directly from VS Code.
- Profile switching for multiple Gitea accounts: configure and switch between multiple Gitea instances/accounts with profile management commands.
- Add Profile command: create new Gitea profiles for multiple accounts/instances.
- Status bar indicator: displays current active Gitea profile with quick access to profile switcher.
- Enhanced notification system with actionable alerts: open issues/PRs in VS Code or browser, and copy commit SHAs directly from alerts.
- Commits section in PR detail view: displays all commits with SHA, message, author, and timestamp for better code review context.
- Conflict details display: when a PR has merge conflicts, shows the actual list of conflicting files with conflict markers instead of a generic error message.
- Out-of-date PR detection: displays an alert banner when a PR branch is behind the base branch with an "Update branch by merge" action button.

### Changed

- Performance tuning: cache GET responses with a 5-minute TTL, throttle refresh bursts, lazily initialize notifications, and defer notification polling to reduce startup cost and API load.

### Fixed
- Repository path lookup now searches subdirectories (up to 2 levels deep) for better repository detection.
- PR detail view now shows an accurate commit count by fetching commit list when the API omits the count.
- Improved repository matching with support for multiple URL formats (SSH, HTTPS, with/without .git suffix).
- Fixed "Repository not found in workspace" error when using `gitea.switchBranch` from command palette.
- Fixed profile list not showing created profiles by reloading from settings on demand.

## [0.1.2] - 2026-01-10

### Changed

- Extension compatibility updated to VS Code 1.90.0 and above.

## [0.1.1] - 2026-01-09

### Added

- `gitea.defaultRepoStartingPath` setting to specify default path for new repositories.

## [0.1.0] - 2026-01-09

### Added

- WebView detail panels for Issues: view full issue details, comments, labels, and state.
- WebView detail panels for Pull Requests: view PR details, commits, files changed, reviews, and comments.
- WebView creation forms: rich forms for creating issues and pull requests with better UX than input boxes.
- Branch selector for PRs: automatically loads branches from selected repository with smart defaults.
- Label support: add labels when creating issues directly from the creation form.
- Assignee support: assign users to pull requests during creation.
- Inline commenting: add comments to issues and pull requests directly from the detail panel.
- PR review actions: approve, comment, or request changes on pull requests.
- PR merge actions: merge, squash, or rebase pull requests with confirmation prompts.
- Close/reopen actions: close or reopen issues and pull requests from detail panels.
- Real-time updates: detail panels refresh after actions to show latest state.

### Changed

- Issue and PR tree items now include "View Details" context menu action with eye icon.
- Create Issue command now opens rich WebView form instead of input boxes.
- Create Pull Request command now opens rich WebView form with branch selection.
- Enhanced UX with color-coded state badges and improved metadata display.

## [0.0.3] - 2026-01-09

### Added

- Issues view grouped by Repository → State (Open/Closed) → Items.
- Pull Requests view grouped by Repository → State (Open/WIP/Closed) → Items, with WIP/draft detection.
- Search commands for Issues and Pull Requests, with flat result display.
- “Open in Browser” commands for repositories, issues, and pull requests.
- Create commands: Repository, Issue, Pull Request.
- Clone-and-open workflow for repositories not yet in the workspace.
- Notifications: polling toggle and status command.

### Changed

- Repository listing now filters to repos actually present in the current workspace by parsing `.git/config` remotes.
- Grouping order switched to Repository → State → Items for improved scanability.

### Fixed

- Stability improvements and activation error fixes in tree providers.

## [0.0.2]

### Added (0.0.2)

- Activity Bar container and basic Repositories/Issues/Pull Requests views.
- Repository search.
- Basic authentication configuration and request handling.

## [0.0.1]

### Added (0.0.1)

- Initial extension scaffold and configuration.
