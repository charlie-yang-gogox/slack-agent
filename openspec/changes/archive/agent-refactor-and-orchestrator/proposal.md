# Proposal: Agent Refactor — PM/Dev/Designer Agents + Orchestrator

## Problem

1. PM and Dev agent logic was hardcoded in `build_prompt.py` as string templates. Prompt changes required modifying the Slack agent repo.
2. No separation between PM and Designer roles — both were inlined in a single prompt.
3. PM/Designer outputs were not cached, requiring full re-generation on retry.
4. `build_prompt.py` had stale branch name casing (lowercase instead of uppercase).

## Solution

### New project-level agents in gogox-flutter

Three new Claude Code agents defined in `.claude/agents/`:

- **pm-agent.md** — Analyzes ticket, produces PRD (problem statement, user stories, acceptance criteria, edge cases, out-of-scope). Does NOT run `/opsx:ff`.
- **designer-agent.md** — Provides UX design guidance (screen flow, component structure, interaction patterns, Figma integration). Does NOT write code.
- **dev-agent.md** — Implements code via `/opsx:apply` → `/opsx:verify` → `flutter test` → commit.

### Orchestrator pattern in agent.js

Single Claude session (opus) acts as orchestrator:
1. Spawns pm-agent and designer-agent as subagents (parallel)
2. Saves outputs as `prd.md` and `design-guidance.md` (cache)
3. Runs `/opsx:ff` with combined PRD + design context

### Cache mechanism

PM/Designer outputs cached in `openspec/changes/{title-slug}/`:
- `prd.md` — pm-agent output
- `design-guidance.md` — designer-agent output

On subsequent runs, orchestrator skips cached subagents and reads files directly.

### build_prompt.py cleanup

- Removed `prd` and `apply` steps (now handled by agents)
- Fixed branch name: `feat/{TICKET_ID}` (uppercase)
- Removed QA subagent from `ff` step
- Kept `ff` (simple `/opsx:ff`) and `revise` steps only

### agent.js changes

- New `buildTicketContext()` helper — reads ticket JSON, builds context string
- New `slugify()` helper
- New `runPMPhase()` — orchestrator session with cache-aware prompt
- PM flows (`prd`, `ff`) use `runPMPhase` instead of `build_prompt.py prd`
- Dev flow uses `--agent dev-agent` instead of `build_prompt.py apply`
- Dev flow in `runDevJob` also uses `runPMPhase` when no artifacts exist
- `runSkill` detects agent-based labels, uses `--agent` flag (no `--model` override, agent defines its own model)
- Strip mention in all message handlers (`recreate`/`reuse`, `approve`/`reject`)
- Confirmation reaction on user's reply message (not thread parent)

## Success Criteria

- `@PMBot prd/ff CAF-XXX` → orchestrator spawns pm-agent + designer-agent → `/opsx:ff`
- Cached prd.md/design-guidance.md skips re-generation
- `@DevBot dev CAF-XXX` → dev-agent handles implementation
- Agents version-controlled in gogox-flutter repo
- `build_prompt.py` only has `ff` and `revise` steps
