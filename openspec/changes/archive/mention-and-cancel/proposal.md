# Proposal: Mention-Based Commands + Cancel Support + Worktree Confirmation

## Problem

1. **No mention support**: Bots use `app.message(regex)` which matches raw text. When users `@mention` the bot, Slack wraps the mention as `<@U_BOT_ID>` which breaks the regex. Users expect to interact with bots via `@BotName command`.

2. **No cancel mechanism**: Once a job starts (PM or Dev), there is no way to stop it. Long-running Claude CLI sessions (up to 28 min) cannot be interrupted. Users must wait for timeout or failure.

3. **No worktree conflict handling**: When a worktree already exists for a ticket, the system silently reuses it. Users have no opportunity to start fresh if the existing worktree is in a bad state.

## Proposed Solution

### Feature 1: Switch to `app_mention` event

- Replace all `pmApp.message(regex)` and `devApp.message(regex)` command listeners with `pmApp.event('app_mention')` / `devApp.event('app_mention')`.
- Strip the `<@U_BOT_ID>` prefix from the event text before matching commands.
- Keep the approval handler (`approve`/`reject`) as a `message` listener since it's a thread reply that doesn't require mention.

### Feature 2: `cancel` command

- Track active `ChildProcess` references per ticket ID in a `Map<ticketId, ChildProcess>`.
- Add a `cancel` command (mention-based for Dev, mention-based for PM) that:
  1. Looks up the active process for the ticket
  2. Sends `SIGTERM` to kill only that process
  3. Force-removes the local worktree and deletes the local branch
  4. Cleans up state (`recentTickets`, `pendingApprovals`)
  5. Replies "Cancelled `{ticketId}`. Worktree and branch removed."
- Scoped to ticket ID — cancelling CAF-121 does not affect CAF-100.
- Only kills **running** jobs, not queued ones (queue is concurrency:1 so only one runs at a time anyway).
- Does NOT delete the remote branch — only local worktree + local branch.

### Feature 3: Worktree existence confirmation

- Before creating a worktree, check if one already exists on the correct branch.
- If it does, ask the user: "Reply `recreate` to delete and rebuild, or `reuse` to continue with existing."
- `recreate` → force-remove worktree + delete branch, then create fresh from remote/trunk.
- `reuse` (or 5 min timeout) → continue with existing worktree.
- Applies to all flows: PM prd, PM update, Dev job.

## Success Criteria

- All commands require `@BotName` mention to trigger
- `@DevBot cancel CAF-121` kills only the CAF-121 Claude process, removes worktree and branch
- Other running sessions are unaffected
- Bot confirms cancellation in the thread
- When a worktree already exists, user is prompted to `recreate` or `reuse`
- Timeout defaults to `reuse` (non-destructive)
