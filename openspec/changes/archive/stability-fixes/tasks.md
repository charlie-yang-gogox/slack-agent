# Tasks: Stability & UX Fixes

## Task 1: Ignore stale events on startup

**File:** `agent.js`

- Add `const startupTs = Date.now() / 1000` at module level
- Add `if (parseFloat(event.ts) < startupTs) return` at top of both `pmApp.event("app_mention")` and `devApp.event("app_mention")` handlers

## Task 2: Cancel early exit checks

**File:** `agent.js`

- prd handler: add `cancelledTickets.has(ticketId)` check before `postThread("PM agent is working...")` and after `build_prompt.py`
- ff handler: same two checks
- runDevJob: add check before `fetch_ticket.py` and after `linear_update.py`
- All checks throw `new Error("Cancelled")` — caught by existing cancel-aware catch blocks

## Task 3: Cancel reaction + messageTs parameter

**File:** `agent.js`

- Change `handleCancel` signature to include `messageTs`: `handleCancel(ticketId, channelId, threadTs, messageTs, client)`
- Add `client.reactions.add({ name: "x" })` on `messageTs` at start of `handleCancel`
- Update both callers (PM and Dev `app_mention` handlers) to pass `messageTs`

## Task 4: Socket Mode keepalive

**File:** `agent.js`

- Add `socketModeOptions: { clientPingTimeout: 30000, serverPingTimeout: 30000 }` to both `pmApp` and `devApp` constructor options

## Task 5: Heartbeat logging in runAsync

**File:** `agent.js`

- When `opts.ticketId` is provided, start `setInterval` (2 min) logging `[ticketId] still running... (Ns elapsed)`
- Clear interval on process `close` event

## Task 6: Archive openspec + commit before push

**File:** `agent.js`

- Before `git push` in runDevJob Step 7:
  1. Move `openspec/changes/*` (excluding `archive/`, `.gitkeep`) to `openspec/changes/archive/`
  2. `git add -A`
  3. Commit if staged changes exist (`git diff --cached --quiet` exit code !== 0)
  4. Commit message: `chore: archive openspec artifacts for {ticketId}`

## Task 7: Worktree confirmation reaction

**File:** `agent.js`

- In `ensureWorktreeInteractive`, after `waitForConfirmation` resolves, add ✅ reaction (`white_check_mark`) on the thread
