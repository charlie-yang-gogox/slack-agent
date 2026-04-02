# Proposal: Use Uppercase Ticket ID in Branch Names

## Problem

Branch names were created with lowercase ticket IDs (`feat/caf-123`) even though ticket IDs are always uppercase (`CAF-123`). This is inconsistent with the project convention.

## Proposed Solution

Remove `.toLowerCase()` from all branch name constructions so branches use the ticket ID as-is (e.g. `feat/CAF-123`).

## Affected Locations

- `ensureWorktree(ticketId)` — branch name construction
- `handleCancel(ticketId, ...)` — branch name for cleanup
- `ensureWorktreeInteractive(ticketId, ...)` — branch name for comparison

## Success Criteria

- Branch names match ticket ID casing: `feat/CAF-123`
