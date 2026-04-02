# Proposal: Stability & UX Fixes

## Problems

1. **Stale events processed on startup**: Slack Socket Mode delivers events that arrived while the agent was offline. Starting the agent causes it to process old commands.

2. **Cancel race condition**: Cancel sets `cancelledTickets` and kills the active process, but if cancel arrives while a synchronous operation (e.g., `build_prompt.py`) is running, the job continues until the next `await` — potentially starting new work after cancel.

3. **No cancel reaction**: The `cancel` command has no visual feedback on the message itself. Other commands (`prd` → memo, `ff` → rocket) have reactions.

4. **Socket Mode disconnects during long runs**: Claude CLI runs up to 28 minutes. WebSocket idle connections get dropped by Slack, causing reconnection errors.

5. **Heartbeat visibility**: No way to tell if the agent is still alive during long Claude CLI runs.

6. **PR creation fails on dirty worktree**: `create_pr.py` runs `dart format`/`dart fix`/`flutter analyze` which may fail if openspec artifacts or other files are uncommitted.

## Solutions

1. Record `startupTs` at boot, ignore `app_mention` events with `event.ts < startupTs`
2. Add `cancelledTickets.has(ticketId)` checks before and after synchronous operations
3. Add ❌ reaction on cancel command message
4. Configure Socket Mode ping keepalive (`clientPingTimeout: 30000`, `serverPingTimeout: 30000`)
5. Log heartbeat every 2 minutes during `runAsync` processes
6. Archive openspec artifacts + `git add -A` + commit before push and `create_pr.py`
