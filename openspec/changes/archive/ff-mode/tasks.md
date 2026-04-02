# Tasks: FF (Fast-Forward) Mode

## Task 1: Retrieve bot user IDs at startup

**File:** `agent.js`

- Add module-level `let pmBotUserId, devBotUserId`
- In startup `(async () => { ... })()`: call `auth.test()` on both apps before `start()`
- Store `user_id` from each response

## Task 2: Add shared state for ff mode

**File:** `agent.js`

- Add `ffTickets` Set — ticketIds currently in ff mode
- Add `ffTicketExtras` Map — ticketId → extra instructions string from `ff CAF-XXX: <instructions>`

## Task 3: Add `ff` route to PM `app_mention` handler

**File:** `agent.js`

- Add regex: `/^ff\s+([A-Z]+-\d+)(?:\s*:\s*([\s\S]+))?$/i`
- FF handler (inside `queue.add`):
  1. React with emoji `rocket`
  2. Fetch ticket
  3. `ensureWorktreeInteractive` (asks recreate/reuse)
  4. Run PM agent (same as prd: build prompt, Claude CLI, commit, push)
  5. Post artifacts to thread (same as prd)
  6. Add ticketId to `ffTickets`
  7. If extra instructions captured, store in `ffTicketExtras`
  8. Post message in thread: `<@${devBotUserId}> dev ${ticketId}` — triggers Dev Bot's `app_mention`
- Catch block: clean up `ffTickets.delete(ticketId)` and `ffTicketExtras.delete(ticketId)` if PM phase fails
- Cancel-safe: check `cancelledTickets.has(ticketId)` in catch

## Task 4: Pass `isFF` flag through Dev handler to `runDevJob`

**File:** `agent.js`

- In Dev `app_mention` handler, after parsing ticketId:
  ```js
  const isFF = ffTickets.has(ticketId);
  ```
- Pass to `runDevJob`:
  ```js
  queue.add(() => runDevJob(ticketId, channelId, threadTs, client, threadContext, { isFF }));
  ```

## Task 5: Modify `runDevJob` to support ff mode

**File:** `agent.js`

- Add `opts = {}` parameter
- When `opts.isFF`:
  - Use `ensureWorktree(ticketId)` instead of `ensureWorktreeInteractive` (skip worktree confirm)
  - Skip `waitForApproval()` — post "Auto-approved (ff mode), starting implementation..."
  - Read `ffTicketExtras.get(ticketId)` as extra instructions, merge with thread context for apply prompt
  - Delete `ffTicketExtras` entry after reading
- When not `opts.isFF`: existing behavior unchanged

## Task 6: Clean up ff state in error/finally paths

**File:** `agent.js`

- In `runDevJob` finally block: `ffTickets.delete(ticketId)`, `ffTicketExtras.delete(ticketId)`
- In PM ff handler catch: same cleanup if PM phase fails before Dev is triggered
