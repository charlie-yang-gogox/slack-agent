# Slack Dev Agent

A Slack-based auto development agent that orchestrates PM and Dev workflows via Claude Code CLI.

## Architecture

- **Two Slack Apps** (Socket Mode): PM Bot and Dev Bot, each with own `xoxb-` / `xapp-` tokens
- **Shared job queue** (`p-queue`, concurrency: 1)
- **Claude Code CLI** (`--print --dangerously-skip-permissions`) for all AI work
- **OpenSpec workflow** (`/opsx:ff`, `/opsx:apply`, `/opsx:verify`) for structured artifact-driven development
- **Project-level Claude agents** (`pm-agent`, `designer-agent`, `dev-agent`) defined in target repo's `.claude/agents/`
- **Orchestrator pattern**: Single opus session spawns PM + Designer as subagents, then runs `/opsx:ff`
- **Git worktrees** (`.claude/worktree/{TICKET_ID}` under `REPO_ROOT`) for isolation — one worktree per ticket, shared between PM and Dev

## Slack Commands

| Command | Bot | Action |
|---|---|---|
| `@PM prd TICKET-ID` | PM | Generate PRD + OpenSpec artifacts |
| `@PM ff TICKET-ID` | PM | Full auto: PRD → artifacts → hand off to Dev → PR |
| `@PM ff TICKET-ID: <instructions>` | PM | FF with extra instructions for Dev |
| `@PM update <feedback>` (in thread) | PM | Revise artifacts based on feedback |
| `@PM port TICKET-ID` | PM | Explore original project → PRD + OpenSpec → post Linear |
| `@PM portff TICKET-ID` | PM | Port full auto: explore → artifacts → Dev → PR |
| `@PM portff TICKET-ID: <instructions>` | PM | Portff with extra Dev instructions |
| `@PM cancel TICKET-ID` | PM | Kill running PM job |
| `@Dev dev TICKET-ID` | Dev | Start implementation using artifacts |
| `@Dev TICKET-ID` | Dev | Direct dev flow (generates artifacts if none exist) |
| `@Dev cancel TICKET-ID` | Dev | Kill running Dev job |
| `approve` / `approve: <instructions>` (in thread) | Dev | Start coding after artifact review |
| `reject` (in thread) | Dev | Cancel |
| `recreate` / `reuse` (in thread) | Both | Worktree conflict resolution |

## PM Agent Flow

```
@PM prd TICKET-ID
→ fetch Linear ticket
→ ensureWorktreeInteractive (asks recreate/reuse if exists)
→ check existing artifacts (skip if proposal.md exists)
→ orchestrator (opus) spawns pm-agent + designer-agent (sonnet, parallel)
→ cache PRD + design guidance as prd.md / design-guidance.md
→ orchestrator runs /opsx:ff with combined context
→ commit + push artifacts
→ post artifact files to Slack thread
→ @user "PRD ready!"
→ [user feedback] → @PM update → revise artifacts → commit + push
```

## FF (Fast-Forward) Flow

```
@PM ff TICKET-ID
→ same as prd flow above
→ then: @Dev dev TICKET-ID (auto-triggered by PM)
→ Dev auto-approves (no human input needed)
→ Dev implements → commit → push → PR → code-review
→ "All done! PR ready: <url>"
```

## Dev Agent Flow

```
@Dev dev TICKET-ID
→ fetch ticket → Linear assign + In Progress
→ ensureWorktree (reuses PM's worktree if in thread, asks if top-level)
→ detect existing artifacts → skip generation / or run PM phase
→ approve/reject (skipped in FF mode)
→ dev-agent: /opsx:apply → /opsx:verify → flutter test → commit
→ safetyCommit + push after each step (progressive push)
→ /commit → /format → archive openspec → push → create_pr.py → /code-review
→ "All done! PR ready: <url>"
```

## Key Design Decisions

- **Orchestrator pattern**: Single opus session spawns pm-agent + designer-agent as subagents. Caches outputs in `openspec/changes/{slug}/prd.md` and `design-guidance.md`. Skips cached agents on retry.
- **Project-level agents**: PM, Designer, Dev agent definitions live in the target repo's `.claude/agents/`, not in this orchestrator repo. Prompts travel with the project.
- **ensureWorktree()**: Shared helper that creates or reuses worktree+branch. PM and Dev share the same worktree so artifacts persist.
- **ensureWorktreeInteractive()**: Asks `recreate`/`reuse` for prd/ff top-level. Skipped for `update`, thread triggers, and FF mode.
- **All work on worktree**: Never modifies REPO_ROOT directly. Each ticket gets `.claude/worktree/{TICKET_ID}` on `feat/{TICKET_ID}` branch.
- **Safety commits**: `safetyCommit()` after every Claude skill step. On failure, partial work is committed and pushed.
- **Progressive push**: Push to remote after every step, not just at the end.
- **Timeout auto-resume**: Claude CLI sessions auto-resume up to 3 times on timeout (45 min per attempt).
- **Cancel**: Kills active process, removes local worktree + branch. Cancel-safe error handlers suppress misleading messages.
- **Stale event filtering**: Events from before startup are ignored (`startupTs`).
- **Socket keepalive**: `clientPingTimeout: 30000` prevents WebSocket idle disconnects.
- **Artifact validation**: `checkArtifacts()` requires `proposal.md` to exist. `cleanAgentOutput()` strips permission errors. Stdout fallback if Write tool fails.
- **Named sessions**: `{ticketId}-orchestrator`, `{ticketId}-pm`, `{ticketId}-designer`, `{ticketId}-dev-agent`, etc.
- **Main branch**: Configurable via target repo. Default worktrees branch from `origin/trunk`.
- **Web dashboard in same process**: Express runs in the same Node.js process as agent.js. Simpler (direct state access), but a dashboard bug could theoretically crash the agent. Mitigated by try/catch on all routes + uncaught exception handlers. Split to separate process if this becomes a problem.
- **No shared mutable state**: web.js reads state via `getStatus()` snapshot function, not by importing raw Maps. This avoids sharing Promises and process handles across modules.
- **Dual approval maps**: `pendingApprovals` (key=threadTs) for Slack, `ticketApprovals` (key=ticketId) for web. Both point to the same Promise resolver. First to resolve wins.
- **Line-based log emission**: `runAsync()` has a dual buffer. Original `stdout += d` untouched for return value. Separate buffer splits on `\n` and emits complete lines. Flushed on process close.
- **SQLite over in-memory**: History persists across restarts. `better-sqlite3` with WAL mode. Batched writes to avoid blocking the event loop.
- **Worktree permission copy**: `.claude/settings.local.json` is gitignored, so `ensureWorktree()` copies it from REPO_ROOT to new worktrees.

## Web Dashboard

A web-based control panel served by the same Node.js process at `http://localhost:3000`. Gives Slack users visibility and control without terminal access.

### Dashboard Architecture

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
    │   public/index.html (dashboard frontend)
    │
    ├─ registerStatusProvider()  → getStatus() returns read-only snapshot
    │
    └─ module.exports { triggerFF, triggerDev, triggerPRD, triggerPort, triggerPortFF, cancelJob, resolveApproval }
        ↑ called by web.js POST endpoints
```

**Key pattern:** State stays in agent.js. web.js accesses it via `getStatus()` (read-only snapshot registered on the event emitter). No shared mutable state between modules.

### Dashboard Tabs

- **Live** — Per-task timeline cards. Each job shows a vertical timeline of steps (Fetch → Worktree → PM → Dev → Commit → Format → Push → Review) with status dots (green=done, yellow pulsing=active, grey=pending). Active step shows last 5 log lines. Running cards have a Cancel button. Cards waiting for approval show Approve/Reject buttons. New job trigger bar at top.
- **History** — Table of past jobs from SQLite. Ticket ID, type, status badge, duration, PR link. Persists across restarts.
- **Actions** — Standalone trigger cards (FF/Dev/PRD/Cancel) + pending approvals list. Mostly superseded by inline buttons on Live tab cards.

### Event Flow

```
Slack @PM ff CAF-123  ─┐
                        ├─► agent.js queue.add()
Web POST /api/jobs/ff ─┘        │
                                ├─ emit("job:start")   ──► SSE → browser shows new card
                                ├─ emit("job:step")    ──► SSE → timeline adds step
                                ├─ emit("job:log")     ──► SSE → active step shows log
                                │                       └► SQLite logs table (batched)
                                ├─ emit("job:complete") ──► SSE → card shows outcome
                                │                        └► SQLite jobs table updated
                                └─ emit("job:error")   ──► SSE → card shows failure
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Agent status, uptime, version |
| `/api/status` | GET | Current state snapshot (active jobs, queue, approvals) |
| `/api/history` | GET | Paginated job history from SQLite |
| `/api/history/:ticketId` | GET | Logs for a specific job |
| `/events` | GET | SSE stream of real-time events |
| `/api/jobs/ff` | POST | Trigger FF mode (returns 202) |
| `/api/jobs/dev` | POST | Trigger Dev mode (returns 202) |
| `/api/jobs/prd` | POST | Trigger PRD mode (returns 202) |
| `/api/jobs/port` | POST | Trigger Port mode (returns 202) |
| `/api/jobs/portff` | POST | Trigger PortFF mode (returns 202) |
| `/api/jobs/cancel` | POST | Cancel running job |
| `/api/approvals/:ticketId/approve` | POST | Approve with optional instructions |
| `/api/approvals/:ticketId/reject` | POST | Reject |

### Web-Triggered Jobs

Web-triggered jobs use a shim Slack client (`webClient` — no-op posting). They don't send Slack messages, only emit events to SSE. Approval uses dual Maps: `pendingApprovals` (key=threadTs, for Slack) and `ticketApprovals` (key=ticketId, for web). First to resolve wins, other is cleaned up.

### SSE Details

- Monotonic event IDs for `Last-Event-Id` reconnection
- Server buffers last 100 events; sends `reset` if client missed more
- Max 20 concurrent connections, 30s heartbeat
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`

### SQLite Persistence

- Location: `db/agent.db` (gitignored, auto-created)
- Tables: `jobs` (ticketId, type, status, startedAt, completedAt, prUrl, error) + `logs` (jobId, timestamp, source, message, level)
- WAL mode, batched log writes (flush every 500ms or 50 lines)
- Schema versioning via `user_version` pragma
- Retention: max 500 jobs / 90 days, cleanup on startup

### Log Capture

Dual buffer in `runAsync()`: existing `stdout += d` untouched (for return value), separate line buffer splits on `\n` and emits complete lines via `agentEvents`. Buffer flushed on process close to capture last partial line. stderr emitted directly (less frequent).

### Error Handling

- All Express routes wrapped in try/catch → 500 JSON, never crash
- `process.on('uncaughtException')` + `process.on('unhandledRejection')` → log and continue
- `SIGTERM` → close Express server, flush SQLite WAL
- Dashboard failure at startup → agent continues without dashboard

### Worktree Permissions

`ensureWorktree()` copies `.claude/settings.local.json` from REPO_ROOT to new worktrees. This file is gitignored, so permissions don't travel with git. Without this copy, Claude Code sessions in worktrees require manual permission acceptance.

## Files

```
agent.js          — Main entry: Slack apps, job queue, PM + Dev handlers, orchestrator, web API exports
events.js         — Shared EventEmitter singleton + getStatus() provider registry
web.js            — Express server, SSE streaming, SQLite persistence, REST API
public/
  index.html      — Single-page dashboard (Live timeline + History + Actions)
db/
  agent.db        — SQLite database (auto-created, gitignored)
test/
  web.test.js     — 11 vitest tests for web.js endpoints and SQLite
build_prompt.py   — Generates Claude prompts for ff/revise steps
fetch_ticket.py   — Linear GraphQL → /tmp/ticket-{id}.json
linear_update.py  — Assigns ticket to self + transitions to In Progress
bin/fvm           — Shim: fvm flutter → flutter
.env.example      — Config template (copy to .env and fill in)
TODOS.md          — Deferred work (auth)
```

## Setup

```bash
cp .env.example .env
# Fill in REPO_ROOT, Slack tokens, Linear API key, PROJECT_NAME
npm install
node agent.js
```

## Configuration (.env)

- `REPO_ROOT` — path to the project repo this agent works on (required)
- `PROJECT_NAME` — project name used in prompts (default: `the target project`)
- `CLAUDE_BIN` — path to claude CLI (default: `claude`)
- `FLUTTER_BIN` — path to flutter CLI (default: `flutter`)
- `DEV_SLACK_BOT_TOKEN` / `DEV_SLACK_APP_TOKEN` — Dev Bot Slack app
- `PM_SLACK_BOT_TOKEN` / `PM_SLACK_APP_TOKEN` — PM Bot Slack app
- `LINEAR_API_KEY` — Linear API access
- `WEB_PORT` — web dashboard port (default: `3000`)

## Target Repo Requirements

The target repo (`REPO_ROOT`) should have these Claude Code agents defined:

```
.claude/agents/
  pm-agent.md       — PRD generation (sonnet)
  designer-agent.md — UX design guidance (sonnet)
  dev-agent.md      — Implementation via /opsx:apply (opus)
```

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
