# Proposal: Move PM/Dev Agent Definitions to gogox-flutter Repo

## Problem

PM and Dev agent logic is hardcoded in `build_prompt.py` as string templates. Changes to prompts or constraints require modifying the Slack agent repo, not the Flutter repo they operate on.

## Solution

Create project-level Claude Code agents in `gogox-flutter/.claude/agents/`:
- `pm-agent.md` — replaces `build_prompt.py` `prd` step
- `dev-agent.md` — replaces `build_prompt.py` `apply` step

Slack agent (`agent.js`) switches from `build_prompt.py` + `--input` to `--agent` + `--print`.

`build_prompt.py` retains `ff` and `revise` steps only. Branch name fixed to uppercase.

## Files Changed

### gogox-flutter repo
- NEW: `.claude/agents/pm-agent.md`
- NEW: `.claude/agents/dev-agent.md`

### slack-agents repo
- MODIFY: `agent.js` — use `--agent` flag for PM and Dev steps
- MODIFY: `build_prompt.py` — remove `prd`/`apply` steps, fix branch uppercase
