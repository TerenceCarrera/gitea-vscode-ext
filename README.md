## Gitea Extension for VS Code

Private VS Code extension for browsing Gitea repositories, tracking issues and pull requests, managing branches, and receiving notifications — all from the Activity Bar.

### Features

- **Repositories view**: shows repos in your workspace whose git remote matches your Gitea instance. Clone, create, and open repos.
- **Issues view**: grouped by repo → open/closed. Create, search, import from XLSX, and view rich detail panels with inline commenting.
- **Pull Requests view**: grouped by repo → open/WIP/closed. Create, review (approve/comment/request changes), merge (merge/squash/rebase), and view commits and diffs.
- **Branch management**: switch branches, create branches from issues/PRs, delete with tracking, restore from history or reflog with diff preview. Export/import deletion history as JSON.
- **Notifications**: optional polling with actionable alerts (open in VS Code, open in browser, copy commit SHA).
- **Multiple profiles**: configure accounts for several Gitea instances. Assign a profile to each workspace via `Gitea: Set Workspace Profile` — the extension auto-switches on open and sets `git config user.name` / `user.email` locally for proper commit attribution.
- **VS Code profile sync**: back up and restore settings, keybindings, and extensions to any Gitea repository.
- **Markdown rendering**: issues and PRs render with full markdown; Gitea-hosted images are fetched with authentication to avoid 403s.

### Getting Started

1. Open a folder containing git repositories
2. Run `Gitea: Configure Instance` — set URL, token, and profile name
3. Open the Gitea Activity Bar to browse repos, issues, and PRs

#### Multi-profile workflow

1. Run `Gitea: Add Profile` for each Gitea instance (optionally set user name and email for commit attribution)
2. Open a workspace, run `Gitea: Set Workspace Profile`, and pick the profile for that workspace
3. The extension saves the choice in `.vscode/settings.json` and auto-applies it on re-open, including `git config user.name` / `user.email`

### Commands

| Command | Action |
|---|---|
| `Gitea: Configure Instance` | Set instance URL, token, and profile |
| `Gitea: Add Profile` | Add another Gitea profile |
| `Gitea: Switch Profile` | Switch active profile globally |
| `Gitea: Set Workspace Profile` | Assign a profile to the current workspace |
| `Gitea: Remove Profile` | Remove a saved profile |
| `Gitea: Search Repositories / Issues / PRs` | Quick search |
| `Gitea: Create Repository / Issue / PR` | Create via rich forms |
| `Gitea: Import Issues from XLSX` | Bulk import issues from Excel |
| `Gitea: Open in Browser` | Open repo/issue/PR in browser |
| `Gitea: View Issue / PR Details` | Rich detail panels |
| `Gitea: Switch Branch` | Checkout branches |
| `Gitea: Delete Branch` | Delete with tracking |
| `Gitea: Restore Deleted Branch` | Restore from history |
| `Gitea: Restore Branch from Reflog` | Scan reflog for old deletions |
| `Gitea: Export / Import Deletion History` | JSON backup and transfer |
| `Gitea: Toggle Notifications` | Enable/disable polling |
| `Gitea: Sync / Restore VS Code Profile` | Backup IDE config to Gitea |

### Settings

Key settings under `gitea.*`:

- `profiles` — configured profiles with `instanceUrl`, `authToken`, and optional `userName`/`userEmail`
- `activeProfile` — current active profile name
- `workspaceProfile` — profile assigned to current workspace (set via command)
- `enableNotifications`, `notificationPollInterval`
- `showAllReposWhenNoWorkspace`, `repoScanDepth`
- `branchDeletionRetentionDays` (1–365, default: 90)

### Performance

- GET responses cached for 10s; cache clears on profile switch
- Pagination: array-returning GET endpoints are auto-paginated via `X-Total-Count`
- Refresh commands throttled (1s debounce)
- Notification polling starts lazily after a 2s delay

### Requirements

- VS Code 1.90.0+
- Git
- Gitea instance and Personal Access Token with **Read & Write** permissions for Repository, Issue, Pull Request and **Read Only** for Notification, User

### Release Notes

See [CHANGELOG.md](CHANGELOG.md) for version history.
