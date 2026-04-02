# Tasks: Mention-Based Commands + Cancel Support + Worktree Confirmation

## Task 1: Add helpers and shared state

**File:** `agent.js`

- Add `stripMention(text)` function that removes `<@UXXXXXX>` prefix from event text
- Add `activeProcesses` Map to shared state (alongside `recentTickets`, `pendingApprovals`)
- Add `cancelledTickets` Set to distinguish cancel from crash
- Add `pendingConfirmations` Map for worktree recreate/reuse prompt

## Task 2: Modify `runAsync` to support process tracking

**File:** `agent.js`

- Add optional `ticketId`, `threadTs`, `channelId` fields to `opts`
- When `opts.ticketId` is provided, register in `activeProcesses` on spawn, remove on close
- Ensure cleanup happens in both success and error paths

## Task 3: Add `waitForConfirmation` and `ensureWorktreeInteractive`

**File:** `agent.js`

- `waitForConfirmation(threadTs)` — same promise pattern as `waitForApproval`, 5 min timeout, defaults to `"reuse"`
- `ensureWorktreeInteractive(ticketId, channelId, threadTs, client)` — checks if worktree exists on correct branch, asks user `recreate`/`reuse`, then delegates to `ensureWorktree`
- If `recreate` → force-remove worktree + delete local branch before calling `ensureWorktree`
- If `reuse` or timeout → call `ensureWorktree` as-is (returns `created: false`)

## Task 4: Switch PM bot from `message` to `app_mention`

**File:** `agent.js`

- Replace `pmApp.message(/^prd\s+/i, ...)` with `pmApp.event('app_mention', ...)`
- Replace `pmApp.message(/^update$/i, ...)` — fold into same `app_mention` handler
- Strip mention from text before matching commands
- Add `cancel` routing for PM
- Add `pmApp.message(...)` handler for `recreate`/`reuse` thread replies
- Replace `ensureWorktree(ticketId)` with `ensureWorktreeInteractive(...)` in prd and update handlers
- Pass `ticketId` to `runAsync` calls inside PM handlers for process tracking

## Task 5: Switch Dev bot from `message` to `app_mention`

**File:** `agent.js`

- Replace `devApp.message(/^(?:dev\s+)?([A-Z]+-\d+)$/i, ...)` with `devApp.event('app_mention', ...)`
- Strip mention from text before matching commands
- Add `cancel` routing for Dev
- Keep `devApp.message(...)` for `approve`/`reject` (thread replies, no mention needed)
- Add `devApp.message(...)` handler for `recreate`/`reuse` thread replies
- Replace `ensureWorktree(ticketId)` with `ensureWorktreeInteractive(...)` in `runDevJob`
- Pass `ticketId` to `runAsync` calls inside `runDevJob` and `runSkill` for process tracking

## Task 6: Implement `handleCancel`

**File:** `agent.js`

- Look up `activeProcesses.get(ticketId)`
- If not found → reply "No running job found for `{ticketId}`."
- If found:
  1. `proc.kill("SIGTERM")` — kill only this ticket's process
  2. Add to `cancelledTickets`
  3. Clean up `activeProcesses`, `recentTickets`, `pendingApprovals`
  4. Force-remove local worktree (`git worktree remove --force`)
  5. Delete local branch (`git branch -D feat/caf-xxx`)
  6. Reply "Cancelled `{ticketId}`. Worktree and branch `feat/caf-xxx` removed."
- Does NOT delete remote branch

## Task 7: Handle cancellation in error paths

**File:** `agent.js`

- In `runDevJob` catch block: if `cancelledTickets.has(ticketId)`, skip error message (already posted "Cancelled")
- In PM prd/update catch blocks: same check
- In `runSkill` retry loop: re-throw immediately if cancelled (skip transient retry)
- Clean up `cancelledTickets` entry in `finally` blocks
