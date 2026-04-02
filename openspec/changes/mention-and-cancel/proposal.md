# Proposal: Mention-Based Commands + Cancel Support

## Problem

1. **No mention support**: Bots use `app.message(regex)` which matches raw text. When users `@mention` the bot, Slack wraps the mention as `<@U_BOT_ID>` which breaks the regex. Users expect to interact with bots via `@BotName command`.

2. **No cancel mechanism**: Once a job starts (PM or Dev), there is no way to stop it. Long-running Claude CLI sessions (up to 28 min) cannot be interrupted. Users must wait for timeout or failure.

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
  3. Cleans up state (`recentTickets`, `pendingApprovals`)
  4. Replies "Cancelled `{ticketId}`."
- Scoped to ticket ID — cancelling CAF-121 does not affect CAF-100.
- Only kills **running** jobs, not queued ones (queue is concurrency:1 so only one runs at a time anyway).

## Success Criteria

- All commands require `@BotName` mention to trigger
- `@DevBot cancel CAF-121` kills only the CAF-121 Claude process
- Other running sessions are unaffected
- Bot confirms cancellation in the thread
