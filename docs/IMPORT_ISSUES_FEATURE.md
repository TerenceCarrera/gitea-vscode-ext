# Import Issues from XLSX

Bulk-import issues from Excel (XLSX) files into any Gitea repository.

## Required columns

- **Title** — issue title

## Optional columns

- **Description** — body text
- **Labels** — comma/semicolon-separated label names (must exist in target repo; case-insensitive)
- **Assignee** — username (must exist in Gitea)
- **Milestone** — name (must exist in target repo)
- **Priority**, **Due Date** — informational

## Usage

1. Click the archive icon in the Issues view title bar
2. Select your XLSX file
3. Pick a target repository
4. Configure import options (assignees, milestones, due dates)
5. Review preview and confirm

The importer validates data and reports failures per row with error messages.
