# Slack Dev Agent

A Slack-based auto development agent that orchestrates PM and Dev workflows via Claude Code CLI.

## Architecture

- **Two Slack Apps** (Socket Mode): PM Bot and Dev Bot, each with own `xoxb-` / `xapp-` tokens
- **Shared job queue** (`p-queue`, concurrency: 1)
- **Claude Code CLI** (`--print --dangerously-skip-permissions`) for all AI work
- **OpenSpec workflow** (`/opsx:ff`, `/opsx:apply`, `/opsx:verify`) for structured artifact-driven development
- **Git worktrees** (`.claude/worktree/{TICKET_ID}` under `REPO_ROOT`) for isolation — one worktree per ticket, shared between PM and Dev

## Slack Commands

| Command | Bot | Action |
|---|---|---|
| `prd CAF-XXX` | PM | Generate PRD + OpenSpec artifacts (proposal, design, specs, tasks) |
| `update` (in thread) | PM | Revise artifacts based on thread feedback |
| `dev CAF-XXX` (in thread or top-level) | Dev | Start implementation using artifacts |
| `CAF-XXX` (top-level) | Dev | Direct dev flow (generates artifacts if none exist) |
| `approve` / `approve: <instructions>` | Dev | Start coding after artifact review |
| `reject` | Dev | Cancel |

## PM Agent Flow

```
prd CAF-XXX
→ fetch Linear ticket
→ ensureWorktree (creates feat/caf-xxx branch)
→ PM + Designer subagents (sonnet) → /opsx:ff
→ commit + push artifacts
→ post artifact files to Slack thread
→ @user "PRD ready!"
→ [user feedback] → update → revise artifacts → commit + push
```

## Dev Agent Flow

```
dev CAF-XXX (or CAF-XXX top-level)
→ fetch ticket → Linear assign + In Progress
→ ensureWorktree (reuses PM's worktree if exists)
→ detect existing artifacts → skip ff / or generate new
→ approve/reject
→ /opsx:apply (opus model, writes code)
→ /opsx:verify
→ /commit → /format → git push → create_pr.py → /code-review
→ "All done! PR ready: <url>"
→ "claude --resume {ticketId}-opsx:apply" for local continuation
```

## Key Design Decisions

- **ensureWorktree()**: Shared helper that creates or reuses worktree+branch. PM and Dev share the same worktree so artifacts persist.
- **All work on worktree**: Never modifies REPO_ROOT directly. Each ticket gets `.claude/worktree/{TICKET_ID}` on `feat/{ticket_id}` branch.
- **Worktree preserved on success and failure**: For debugging or local `claude --resume`.
- **Named sessions**: Each Claude run gets `--name {ticketId}-{step}` for easy resume.
- **Dev uses opus model**: For higher quality implementation.
- **PM subagents use sonnet**: For faster PRD generation.
- **Retry on API 500/529**: Up to 2 retries with backoff.
- **fvm shim**: `bin/fvm` redirects `fvm flutter` → `flutter` since fvm isn't installed locally.
- **Thread context**: When dev is triggered from a PM thread, all thread messages are injected into the prompt.
- **Approve with instructions**: `approve: focus on error handling` appends to apply prompt.
- **Main branch is `trunk`**: All branches are created from `origin/trunk`, PRs target `trunk`.

## Files

```
agent.js          — Main entry: two Slack apps, job queue, PM + Dev handlers
build_prompt.py   — Generates Claude prompts for ff/prd/apply/revise steps
fetch_ticket.py   — Linear GraphQL → /tmp/ticket-{id}.json
linear_update.py  — Assigns ticket to self + transitions to In Progress
bin/fvm           — Shim: fvm flutter → flutter
.env.example      — Config template (copy to .env and fill in)
```

## Setup

```bash
cp .env.example .env
# Fill in REPO_ROOT, Slack tokens, Linear API key
npm install
node agent.js
```

## Configuration (.env)

- `REPO_ROOT` — path to the Flutter project this agent works on (required)
- `CLAUDE_BIN` — path to claude CLI (default: `claude`)
- `FLUTTER_BIN` — path to flutter CLI (default: `flutter`)
- `DEV_SLACK_BOT_TOKEN` / `DEV_SLACK_APP_TOKEN` — Dev Bot Slack app
- `PM_SLACK_BOT_TOKEN` / `PM_SLACK_APP_TOKEN` — PM Bot Slack app
- `LINEAR_API_KEY` — Linear API access
