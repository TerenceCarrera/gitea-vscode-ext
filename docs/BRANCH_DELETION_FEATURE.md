# Branch Deletion & Restoration

## Features

- **Deleted Branches view**: tree view in the Gitea activity bar showing tracked deletions per repository with timestamps
- **Persistent storage**: history survives restarts via VS Code globalState; syncs across machines with Settings Sync
- **Reflog parsing**: detects deletions made outside the extension (standard delete, force delete, remote delete, update-ref)
- **Configurable retention**: `gitea.branchDeletionRetentionDays` (1–365, default: 90)
- **Diff preview**: review changed files before restoring, click files to open VS Code diff viewer
- **Export/import**: save/load deletion history as JSON for backup or transfer (merge or replace strategy)

## Commands

| Command | Action |
|---|---|
| `Gitea: Delete Branch` | Delete with normal or force option |
| `Gitea: Restore Deleted Branch` | Restore from tracked history |
| `Gitea: Restore Branch from Reflog` | Scan reflog for historical deletions |
| `Gitea: Export Deletion History` | Save to JSON |
| `Gitea: Import Deletion History` | Load from JSON |
