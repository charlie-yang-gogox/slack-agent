# Tasks: Mention-Based Commands + Cancel Support

## Task 1: Add `stripMention` helper and `activeProcesses` map

**File:** `agent.js`

- Add `stripMention(text)` function that removes `<@UXXXXXX>` prefix from event text
- Add `activeProcesses` Map to shared state (alongside `recentTickets`, `pendingApprovals`)
- Add `cancelledTickets` Set to distinguish cancel from crash

## Task 2: Modify `runAsync` to support process tracking

**File:** `agent.js`

- Add optional `ticketId`, `threadTs`, `channelId` fields to `opts`
- When `opts.ticketId` is provided, register in `activeProcesses` on spawn, remove on close
- Ensure cleanup happens in both success and error paths

## Task 3: Switch PM bot from `message` to `app_mention`

**File:** `agent.js`

- Replace `pmApp.message(/^prd\s+/i, ...)` with `pmApp.event('app_mention', ...)`
- Replace `pmApp.message(/^update$/i, ...)` — fold into same `app_mention` handler
- Strip mention from text before matching commands
- Add `cancel` routing for PM
- Pass `ticketId` to `runAsync` calls inside PM handlers for process tracking

## Task 4: Switch Dev bot from `message` to `app_mention`

**File:** `agent.js`

- Replace `devApp.message(/^(?:dev\s+)?([A-Z]+-\d+)$/i, ...)` with `devApp.event('app_mention', ...)`
- Strip mention from text before matching commands
- Add `cancel` routing for Dev
- Keep `devApp.message(...)` for `approve`/`reject` (thread replies, no mention needed)
- Pass `ticketId` to `runAsync` calls inside `runDevJob` and `runSkill` for process tracking

## Task 5: Implement `handleCancel`

**File:** `agent.js`

- Look up `activeProcesses.get(ticketId)`
- If not found → reply "No running job found for `{ticketId}`."
- If found → `proc.kill("SIGTERM")`, add to `cancelledTickets`, clean up maps, reply "Cancelled `{ticketId}`."

## Task 6: Handle cancellation in error paths

**File:** `agent.js`

- In `runDevJob` catch block: if `cancelledTickets.has(ticketId)`, skip error message (already posted "Cancelled")
- In PM prd/update catch blocks: same check
- Clean up `cancelledTickets` entry in `finally` blocks
