# Tasks: Use Uppercase Ticket ID in Branch Names

## Task 1: Remove `.toLowerCase()` from branch name construction

**File:** `agent.js`

- `ensureWorktree`: change `feat/${ticketId.toLowerCase()}` → `feat/${ticketId}`
- `handleCancel`: same change
- `ensureWorktreeInteractive`: same change
