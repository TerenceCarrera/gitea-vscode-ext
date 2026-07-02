# Changelog

All notable changes to this project are documented in this file.
This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.4.0] - 2026-07-02

### Changed

- **Converted codebase from JavaScript to TypeScript**: all source files are now `.ts`. Added `tsconfig.json`, build (`tsc`), and proper type annotations throughout.
- **License changed to proprietary (All Rights Reserved)**: project is now private. Updated `LICENSE`, `package.json` (`private: true`, `license: "SEE LICENSE IN LICENSE"`).
- **ESLint updated for TypeScript**: added `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` for TS-aware linting.

### Removed

- Old `.js` source files and `jsconfig.json` cleaned up.

## [0.3.1] - 2026-06-13

### Fixed

- **`allRepos.map is not a function` crash in tree providers** (issue [#20](https://github.com/terence-carrera/gitea-vscode/issues/20)): `filterRepositoriesByWorkspace` now guards against non-array `allRepos` values returned by the API client when the server response is not a JSON array (e.g., HTML error page, JSON error object, or unexpected format). The tree views (Repositories, Issues, Pull Requests) degrade gracefully instead of failing with `allRepos.map is not a function`.

## [0.3.0] - 2026-06-13

### Added

- **Workspace profile binding**: assign a Gitea profile to the current workspace via `Gitea: Set Workspace Profile`. The profile is saved in `.vscode/settings.json` and auto-applied on re-open.
- **Git identity per profile**: profiles now have optional `userName` and `userEmail` fields. When a workspace profile is set, the extension runs `git config user.name` / `user.email` (local) in every workspace git repo so commits use the right identity automatically.

### Changed

- **auth.ts** parses `gitea.profiles` with `userName` / `userEmail` and passes them to `setGitUserConfig` on workspace-profile switch.
- **`setGitUserConfig`** in `gitUtils.js` accepts an optional email and writes both name and email via `git config --local`.
- **Notifications** now check `.length` instead of truthiness on the notifications array to handle `undefined` gracefully (0 notifications is not an error).

## [0.2.2] - 2026-06-13

### Fixed

- **Missing store dependency fix**: The `NotificationManager` import was not properly bound in the extension activation, causing `store is undefined` when profile-scoped notification data was queried. The notification badge and notification panel now render correctly after a profile switch.

## [0.2.1] - 2026-06-12

### Fixed

- **`startsWith` call on undefined in notification commands**: `gitea.toggleNotifications` and `gitea.notificationStatus` now guard against an undefined `_notificationManager`, preventing `Cannot read properties of undefined (reading 'startsWith')` when notifications were never initialized.
- **`NlsManager` and `_config` guard in activation**: `auth.initialize()` returns early when `gitea.authToken` is unset, preventing `Cannot read properties of undefined (reading 'replace')` in `makeRequest` when the user opens the workspace before configuring the extension.
- **`diffList.map` crash on empty repo**: `parseDiffToFiles` now returns an empty array when `diffContent` is blank or contains only headers, preventing a `diffList.map is not a function` crash on repositories with no file changes.

## [0.2.0] - 2026-06-11

### Added

- **Branch deletion tracking**: when a branch is deleted via the extension, its metadata (name, commit SHA, timestamp, and author) is saved locally and displayed in the new Deleted Branches view.
- **Branch restoration**: restore a deleted branch from:

  - **Deletion history**: one-click restore from the tracked-deletion log.
  - **Git reflog**: scan `git reflog` for the commit SHA of a long-gone branch and recreate it.
  - **Git tree**: advanced recovery by pasting a tree SHA directly.

- **Diff preview before restore**: select any deleted branch to see a diff of its tip commit against the current branch, helping you decide whether to restore it.
- **Deletion history management**: export to JSON, import from JSON, clear all, or remove individual entries. Useful for transferring history between machines or after a re-clone.
- **`branchDeletionRetentionDays` setting** (1–365, default: 90) controls automatic cleanup of old entries.

## [0.1.0] - 2026-05-01

### Added

- Initial release with repository browsing, issue and PR management, basic notifications, and multi-profile support.
