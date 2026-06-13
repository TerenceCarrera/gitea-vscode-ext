# Workspace Repository Detection

The extension matches repositories to your workspace by scanning local git metadata and comparing remotes to your Gitea instance.

- Scans workspace folders for `.git` directories (supports worktrees and submodules)
- Reads each repo's remote URL from `git config`
- A repo matches if its `clone_url`, `html_url`, or `full_name` appears in the config
- Scan depth: configurable via `gitea.repoScanDepth` (default: 2, range: 0–6)

If no repos are found, the extension can prompt you to open a folder, clone a repo, or show all repos (`gitea.showAllReposWhenNoWorkspace`).
