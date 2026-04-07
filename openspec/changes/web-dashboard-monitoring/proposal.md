# Proposal: Web Dashboard + Port Command Fixes

## Problem

1. **No visibility without Slack**: Monitoring agent jobs requires watching Slack threads. No browser-based view for team members.
2. **No persistent history**: All job knowledge lost on agent restart. No way to review past runs or failure patterns.
3. **No web-based control**: Triggering jobs and approving artifacts requires Slack messages.
4. **Port Linear writes broken**: `upsertPortComment()` used `issueSearch` (full-text API) instead of identifier lookup — always returned empty, so Linear comments never posted.
5. **Explore ghost jobs on dashboard**: `runExplore()` registered in `activeProcesses` as `CAF-XXX:explore` (with colon suffix) but lifecycle events used `CAF-XXX` — dashboard showed a phantom job that never completed.
6. **Dashboard timer frozen**: Frontend `setInterval` only updated job-level elapsed time, not active step duration. Between SSE events, step timers appeared frozen.

## Proposed Solution

### Phase 1: Real-Time Monitoring
- **Live tab**: Per-task timeline cards with vertical step timeline (Fetch → Worktree → Check Artifacts → Explore → PM Agent → Dev Agent → Commit → Format → Push + PR → Code Review). Status dots (green=done, yellow pulsing=active, grey=pending) with last 5 log lines for active step.
- **History tab**: Paginated table from SQLite. Ticket ID, type, status badge, duration, PR link. Persists across restarts.
- **SSE streaming**: Real-time events via Server-Sent Events. Monotonic IDs with `Last-Event-Id` reconnection. Buffer last 100 events.

### Phase 2: Action Triggers
- **Inline card actions**: Cancel on running jobs, Approve/Reject on approval-waiting jobs.
- **New job trigger bar**: Type dropdown (FF/Dev/PRD/Port/PortFF) + ticket ID + instructions.
- **REST API**: POST endpoints for all job types + cancel + approve/reject.
- **Web-triggered jobs**: Shim Slack client (no-op). Dual approval maps (threadTs for Slack, ticketId for web), first-wins.

### Phase 3: Port Command Restoration + Fixes
- **Port/PortFF commands restored**: Both Slack commands and web API triggers.
- **Linear writes via Claude CLI**: Replaced broken `upsertPortComment()` (direct GraphQL) with `postPortArtifactsToLinear()` that delegates to target repo's Linear MCP tools via Claude CLI session. Same HTML marker format for compatibility with `port-feature` skill.
- **`ORIGINAL_PROJECT_PATH` from port-settings.json**: Reads from `REPO_ROOT/.claude/port-settings.json` (set by target repo's `/port` skill) instead of `.env`.

### Bug Fixes
- **Explore ticketId**: `runExplore()` now passes bare `ticketId` to `runAsync()` instead of `${ticketId}:explore`. Logs and `activeProcesses` use the same key as lifecycle events.
- **Dashboard timer**: `setInterval` now also updates `.tl-item.active .tl-duration` every second. Uses `CSS.escape()` for ticketId in selectors.

### Supporting Changes
- **Event bus** (`events.js`): Shared `EventEmitter` singleton.
- **Status provider**: `registerStatusProvider()` for read-only state snapshots.
- **SQLite persistence**: `better-sqlite3`, WAL mode, batched writes, retention cleanup.
- **Line-based log capture**: Dual buffer in `runAsync()`.
- **Worktree permission copy**: `.claude/settings.local.json` copied to new worktrees.
- **Centralized cleanup**: `cleanupTicket()` helper.
- **Error isolation**: try/catch on all routes, uncaught exception handlers.

## Success Criteria

- Dashboard shows live job progress via SSE including port/portff jobs
- Port/PortFF jobs post artifacts to Linear via Claude CLI MCP tools
- Explore step logs appear under correct job card (no ghost `CAF-XXX:explore` card)
- Active step timer ticks every second without SSE events
- Job history persists across restarts
- Jobs triggered and cancelled from web UI
- Approval works from both Slack and web (first wins)
- Agent continues if dashboard fails to start

## Scope

**In scope**: Dashboard, history, all job triggers (including port), Linear via CLI, explore/timer bug fixes.

**Out of scope**: Authentication (deferred — TODOS.md), multi-user sessions, deployment beyond localhost.
