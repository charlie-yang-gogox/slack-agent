# Design: Use Uppercase Ticket ID in Branch Names

## Change

Replace all instances of `ticketId.toLowerCase()` in branch name construction with `ticketId` directly.

**Before:**
```js
const branch = `feat/${ticketId.toLowerCase()}`; // feat/caf-123
```

**After:**
```js
const branch = `feat/${ticketId}`; // feat/CAF-123
```

## Locations (all in `agent.js`)

1. `ensureWorktree(ticketId)` — line ~195
2. `handleCancel(ticketId, ...)` — line ~206
3. `ensureWorktreeInteractive(ticketId, ...)` — line ~243

## Files Modified

- `agent.js` — 3 occurrences of `.toLowerCase()` removed
