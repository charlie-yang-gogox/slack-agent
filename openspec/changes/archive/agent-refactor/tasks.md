# Tasks: Move PM/Dev Agent Definitions to gogox-flutter Repo

## Task 1: Create pm-agent.md in gogox-flutter

**File:** `gogox-flutter/.claude/agents/pm-agent.md`

- Frontmatter: name, description, tools, model (sonnet)
- Body: PM role, spawn PM + Designer subagents, `/opsx:ff`, constraints
- Port all logic from `build_prompt.py` `prd` step

## Task 2: Create dev-agent.md in gogox-flutter

**File:** `gogox-flutter/.claude/agents/dev-agent.md`

- Frontmatter: name, description, tools, model (opus)
- Body: Dev role, `/opsx:apply` → `/opsx:verify` → `flutter test` → commit, constraints
- Port all logic from `build_prompt.py` `apply` step

## Task 3: Add `buildTicketContext` helper to agent.js

**File:** `slack-agents/agent.js`

- Read `/tmp/ticket-{ticketId}.json`
- Build context string: ticket_id, title, description, branch, worktree_path, extra instructions

## Task 4: Update PM flows in agent.js to use --agent

**File:** `slack-agents/agent.js`

- `prd` handler: replace `build_prompt.py prd` + `runAsync` with `--agent pm-agent`
- `ff` handler (non-skip path): same replacement
- Use `buildTicketContext` for input

## Task 5: Update Dev flow in agent.js to use --agent

**File:** `slack-agents/agent.js`

- `runSkill` for apply step: use `--agent dev-agent` instead of building prompt via `build_prompt.py apply`
- Update `runSkill` to detect agent-based labels and use `--agent` flag

## Task 6: Clean up build_prompt.py

**File:** `slack-agents/build_prompt.py`

- Remove `prd` and `apply` step branches
- Fix branch name: `feat/{ticket_id}` (remove `.lower()`)
- Keep `ff` and `revise` steps only
