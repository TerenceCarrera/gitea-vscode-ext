# VS Code Settings Sync

Branch deletion history syncs automatically across machines using **VS Code Settings Sync**.

## Setup

1. Click the gear icon (⚙️) → **Turn on Settings Sync...**
2. Sign in with Microsoft or GitHub
3. Ensure **User Data** is checked

That's it. The extension registers deletion history for sync via `context.globalState.setKeysForSync()`.

## Manual backup

Use `Gitea: Export Deletion History` to save to JSON, and `Gitea: Import Deletion History` to restore.
