# Tasks: Web Dashboard + Port Command Fixes

## Task 1: Event bus module

**File:** `events.js` (new)

- Shared `EventEmitter` singleton (`agentEvents`, maxListeners 30)
- `registerStatusProvider(fn)` + `getStatus()`

## Task 2: Agent lifecycle event emission

**File:** `agent.js`

- Import `agentEvents`, `registerStatusProvider` from `events.js`
- Register status provider returning `{ activeJobs, queueSize, pendingApprovals, ffTickets, uptime }`
- Add `ticketApprovals` Map (key=ticketId, parallel to threadTs-based `pendingApprovals`)
- Create `webClient` shim (no-op Slack client)
- Create `cleanupTicket()` helper
- Modify `runAsync()`: dual line buffer, emit `job:log` on complete lines, flush on close
- Modify `waitForApproval()`: accept `ticketId`, register in both maps, shared resolver
- Modify `ensureWorktree()`: copy `.claude/settings.local.json` to new worktrees
- Emit lifecycle events at every step in PRD, FF, Port, PortFF, Dev handlers

## Task 3: Agent web API exports

**File:** `agent.js`

- `triggerFF(ticketId, instructions)`
- `triggerDev(ticketId)`
- `triggerPRD(ticketId)`
- `triggerPort(ticketId)` — with `ORIGINAL_PROJECT_PATH` validation
- `triggerPortFF(ticketId, instructions)` — port + auto dev handoff
- `cancelJob(ticketId)`
- `resolveApproval(ticketId, decision, instructions)`
- `uncaughtException` / `unhandledRejection` handlers
- `require("./web")` in try/catch at startup

## Task 4: Port commands — restore with fixes

**File:** `agent.js`

- Read `ORIGINAL_PROJECT_PATH` from `REPO_ROOT/.claude/port-settings.json` (not `.env`)
- Restore `runExplore()` function
- Restore `port`/`portff` regex matchers and Slack command handlers
- Restore `sourceAnalysis` parameter in `runPMPhase()`
- Restore source analysis injection into PM agent, Designer agent, and orchestrator prompts
- Restore port-related Linear sync in `update` handler

## Task 5: Fix — Linear writes via Claude CLI

**File:** `agent.js`

- Remove `getLinearIssueUuid()` (broken `issueSearch` query)
- Remove `composePortCommentBody()`, `upsertPortComment()`, `PORT_COMMENT_ID_FILE`, port-specific `LINEAR_API_KEY`
- Add `postPortArtifactsToLinear(ticketId, worktreePath)`:
  - Reads artifact files from worktree
  - Composes body with HTML markers (`PORT:SOURCE_ANALYSIS`, `PORT:PRD`, `PORT:DESIGN_CHANGED`)
  - Delegates to Claude CLI which uses target repo's Linear MCP tool (`save_comment`)
  - 5 min timeout, non-fatal on failure
- Replace all 4 `upsertPortComment` call sites with `postPortArtifactsToLinear`

## Task 6: Fix — Explore ticketId mismatch

**File:** `agent.js`

- Change `runExplore()` → `runAsync(..., { ticketId })` (was `${ticketId}:explore`)
- Ensures `activeProcesses`, `job:log` events, and lifecycle events all use same key
- Eliminates ghost job card on dashboard

## Task 7: Fix — Dashboard timer frozen between events

**File:** `public/index.html`

- `setInterval` now also updates `.tl-item.active .tl-duration` every second
- Use `CSS.escape(job.ticketId)` in `querySelector` for selector safety
- Cache `Date.now()` once per tick

## Task 8: Web server with SQLite persistence

**File:** `web.js` (new)

- SQLite at `db/agent.db`, WAL mode
- `jobs` + `logs` tables with indexes
- Retention cleanup on startup (500 jobs / 90 days)
- Prepared statements, log write batcher (50 lines / 500ms)
- Listen to `agentEvents`: persist + broadcast to SSE

## Task 9: REST API endpoints

**File:** `web.js`

- GET: `/api/health`, `/api/status`, `/api/history`, `/api/history/:ticketId`
- POST: `/api/jobs/ff`, `/api/jobs/dev`, `/api/jobs/prd`, `/api/jobs/port`, `/api/jobs/portff`, `/api/jobs/cancel`
- POST: `/api/approvals/:ticketId/approve`, `/api/approvals/:ticketId/reject`
- All routes try/catch → 500 JSON

## Task 10: SSE streaming

**File:** `web.js`

- `GET /events` with proper headers
- Max 20 connections, monotonic IDs, ring buffer (100)
- `Last-Event-Id` replay or `reset`
- 30s heartbeat, cleanup on disconnect

## Task 11: Dashboard frontend

**File:** `public/index.html` (new)

- Dark theme, monospace, three tabs (Live/History/Actions)
- Job type dropdown: FF, Dev, PRD, Port, PortFF
- Timeline step names: fetch-ticket, worktree, check-artifacts, explore, pm-agent, dev-agent, commit, format, push-pr, push-artifacts, code-review
- Inline actions (Cancel / Approve+Reject)
- SSE client with all event handlers

## Task 12: Configuration and cleanup

**Files:** `.env.example`, `.gitignore`, `package.json`, `TODOS.md`

- Remove `ORIGINAL_PROJECT_PATH` from `.env.example` (now from port-settings.json)
- Add `WEB_PORT=3000` to `.env.example`
- Add `db/`, `.gstack/` to `.gitignore`
- Add `better-sqlite3`, `express`, `vitest`
- Create `TODOS.md` (deferred auth)

## Task 13: Update documentation

**File:** `CLAUDE.md`

- Add port/portff back to Slack Commands table
- Add Web Dashboard section (architecture, tabs, event flow, API, SSE, SQLite, error handling)
- Update Files listing
- Add `WEB_PORT` to Configuration
- Add gstack skill routing rules

## Task 14: Tests

**File:** `test/web.test.js` (new)

- 11 vitest tests: health, status, history (empty/populated/pagination), history detail (404/found), SSE headers, SQLite tables, log batching, error handling
