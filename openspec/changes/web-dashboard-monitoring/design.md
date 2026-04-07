# Design: Web Dashboard + Port Command Fixes

## Architecture

```
agent.js (Slack bots + job logic + state)
    │
    ├─ agentEvents.emit()     ← ~20 lifecycle emit points
    │       │
    │       ▼
    │   events.js (shared EventEmitter singleton)
    │       │
    │       ▼
    │   web.js (Express :3000 + SQLite + SSE)
    │       │
    │       ▼
    │   public/index.html (SPA dashboard)
    │
    ├─ registerStatusProvider()  → getStatus() returns read-only snapshot
    │
    └─ module.exports { triggerFF, triggerDev, triggerPRD, triggerPort, triggerPortFF, cancelJob, resolveApproval }
        ↑ called by web.js POST endpoints (lazy-loaded via require("./agent"))
```

### Module Boundaries

- **agent.js → events.js**: Emits lifecycle events. Registers status provider.
- **web.js → events.js**: Listens to all events. Persists to SQLite. Broadcasts to SSE.
- **web.js → agent.js**: Lazy `require("./agent")` for POST endpoints.
- **agent.js → web.js**: `require("./web")` at startup (try/catch).

### No Shared Mutable State

web.js reads state via `getStatus()` snapshot. No direct import of Maps/Sets/Promises.

### Dual Approval

```
Slack "approve" in thread  →  pendingApprovals.get(threadTs).resolve()  ─┐
                                                                          ├─ same Promise
Web POST /api/approvals/:ticketId/approve  →  ticketApprovals.get(ticketId).resolve()  ─┘
```

First to call wins. Resolver cleans up both maps.

## Port Command Changes

### Linear Writes: Before vs After

**Before (broken):**
```
agent.js → getLinearIssueUuid() → issueSearch(filter: {identifier: {eq: "CAF-XXX"}})
                                   ↑ wrong API — issueSearch is full-text, not filter-based
                                   → always returns null → "Could not find Linear issue UUID"
```

**After:**
```
agent.js → postPortArtifactsToLinear() → Claude CLI session
              ↓
           Claude uses target repo's Linear MCP tool (save_comment)
              ↓
           Comment posted with HTML markers (PORT:SOURCE_ANALYSIS, PORT:PRD, PORT:DESIGN_CHANGED)
```

### `ORIGINAL_PROJECT_PATH` Source

**Before:** `process.env.ORIGINAL_PROJECT_PATH` from `.env`

**After:** Read from `REPO_ROOT/.claude/port-settings.json` (set by target repo's `/port` skill):
```js
const PORT_SETTINGS_PATH = path.join(REPO_ROOT, ".claude", "port-settings.json");
const ORIGINAL_PROJECT_PATH = (() => {
  try { return JSON.parse(fs.readFileSync(PORT_SETTINGS_PATH, "utf8")).originalProjectPath || ""; }
  catch { return ""; }
})();
```

### `postPortArtifactsToLinear(ticketId, worktreePath)`

Reads artifact files from worktree, composes HTML-marked body, sends via Claude CLI:
- Timeout: 5 minutes (vs 45 min for explore/dev)
- Session name: `${ticketId}-linear-post`
- Failure: logged + swallowed (non-fatal — artifacts still in git)

## Bug Fix: Explore ticketId

**Before:** `runAsync(..., { ticketId: \`${ticketId}:explore\` })` — registered `CAF-XXX:explore` in `activeProcesses` and emitted `job:log` with that key. Dashboard created ghost card.

**After:** `runAsync(..., { ticketId })` — uses bare `CAF-XXX`. Logs go to correct job card under the `explore` step.

## Bug Fix: Dashboard Timer

**Before:** `setInterval` only updated `.task-meta` (job-level elapsed). Active step's `.tl-duration` was rendered once and never updated.

**After:** `setInterval` also finds `.tl-item.active .tl-duration` and updates it every second. Uses `CSS.escape(job.ticketId)` for selector safety.

## Event System (`events.js`)

18 lines. `EventEmitter` with maxListeners 30. `registerStatusProvider(fn)` + `getStatus()`.

## SQLite Schema

```sql
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticketId TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  startedAt TEXT NOT NULL,
  completedAt TEXT,
  prUrl TEXT,
  triggeredBy TEXT,
  error TEXT
);

CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jobId INTEGER NOT NULL REFERENCES jobs(id),
  timestamp TEXT NOT NULL,
  source TEXT,
  message TEXT NOT NULL,
  level TEXT DEFAULT 'info'
);
```

WAL mode. Batched log writes (50 lines or 500ms). Retention: 500 jobs / 90 days.

## REST API

| Endpoint | Method | Status | Description |
|---|---|---|---|
| `/api/health` | GET | 200 | `{ status, uptime, version }` |
| `/api/status` | GET | 200 | Snapshot via `getStatus()` |
| `/api/history` | GET | 200 | `?limit=50&offset=0` → job array |
| `/api/history/:ticketId` | GET | 200/404 | Job + logs |
| `/events` | GET | 200 | SSE stream |
| `/api/jobs/ff` | POST | 202/409/422 | `{ ticketId, instructions? }` |
| `/api/jobs/dev` | POST | 202/409/422 | `{ ticketId }` |
| `/api/jobs/prd` | POST | 202/409/422 | `{ ticketId }` |
| `/api/jobs/port` | POST | 202/409/422 | `{ ticketId }` |
| `/api/jobs/portff` | POST | 202/409/422 | `{ ticketId, instructions? }` |
| `/api/jobs/cancel` | POST | 200/404/422 | `{ ticketId }` |
| `/api/approvals/:ticketId/approve` | POST | 200/404 | `{ instructions? }` |
| `/api/approvals/:ticketId/reject` | POST | 200/404 | — |

## SSE

- Monotonic event IDs, ring buffer (100 entries)
- `Last-Event-Id` replay or `reset` event
- Max 20 connections, 30s heartbeat
- Events: `job:start`, `job:step`, `job:log`, `job:complete`, `job:error`, `queue:update`, `approval:pending`, `approval:resolved`, `reset`

## Dashboard Frontend

Single HTML file, no build step. Dark theme, monospace. Three tabs (Live, History, Actions). Job type dropdown includes Port/PortFF. Timeline step names include `explore`.

## Dependencies

New: `express` ^5.2.1, `better-sqlite3` ^12.8.0, `vitest` ^4.1.2 (dev)
