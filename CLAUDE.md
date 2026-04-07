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

## Files

```
agent.js          — Main entry: two Slack apps, job queue, PM + Dev handlers, orchestrator
build_prompt.py   — Generates Claude prompts for ff/revise steps
fetch_ticket.py   — Linear GraphQL → /tmp/ticket-{id}.json
linear_update.py  — Assigns ticket to self + transitions to In Progress
bin/fvm           — Shim: fvm flutter → flutter
.env.example      — Config template (copy to .env and fill in)
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

## Target Repo Requirements

The target repo (`REPO_ROOT`) should have these Claude Code agents defined:

```
.claude/agents/
  pm-agent.md       — PRD generation (sonnet)
  designer-agent.md — UX design guidance (sonnet)
  dev-agent.md      — Implementation via /opsx:apply (opus)
```
