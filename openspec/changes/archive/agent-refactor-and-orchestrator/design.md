# Design: Agent Refactor — PM/Dev/Designer Agents + Orchestrator

## New files in gogox-flutter

### `.claude/agents/pm-agent.md`
- Model: sonnet
- Tools: Bash, Glob, Grep, Read, Write, ToolSearch
- Role: Analyze ticket + codebase, produce PRD as structured markdown
- Does NOT run `/opsx:ff` or `/opsx:apply`
- Does NOT spawn subagents

### `.claude/agents/designer-agent.md`
- Model: sonnet
- Tools: Bash, Glob, Grep, Read, ToolSearch + Figma MCP tools
- Role: Provide UX design guidance, reference existing components
- Figma integration: if URL provided, fetches design spec via MCP
- Does NOT write code

### `.claude/agents/dev-agent.md`
- Model: opus
- Tools: Bash, Edit, Glob, Grep, Read, Write, Skill, Task*, ToolSearch
- Role: `/opsx:apply` → `/opsx:verify` → `flutter test` → `git add -A` + commit
- Constraints: only modify `lib/`, `test/`, `openspec/`; use AppColors; don't push

## Orchestrator pattern (`runPMPhase` in agent.js)

Single Claude session (opus) with cache-aware prompt:

```
orchestrator (opus)
├── check prd.md cache → skip or spawn pm-agent (sonnet)
├── check design-guidance.md cache → skip or spawn designer-agent (sonnet)
└── /opsx:ff {title_slug} with combined outputs
```

Cache files stored at `openspec/changes/{title-slug}/prd.md` and `design-guidance.md`.

Four cache states handled:
- Neither cached → spawn both in parallel
- Only PRD cached → read prd.md, spawn designer-agent only
- Only design cached → read design-guidance.md, spawn pm-agent only
- Both cached → skip both, read files, jump to /opsx:ff

## agent.js key changes

### `buildTicketContext(ticketId, worktreePath, extra)`
Reads `/tmp/ticket-{id}.json`, returns formatted context string.

### `runSkill` agent detection
```js
const isAgent = ["pm-agent", "dev-agent"].includes(label);
if (isAgent) args = ["--print", "--dangerously-skip-permissions", "--agent", label, "--name", sessionName];
```
No `--model` override — agent `.md` defines its own model.

### Dev flow
```
buildTicketContext(ticketId, worktreePath, applyExtra)
→ runSkill("dev-agent", devContext)
→ safetyCommit + push
→ /commit → /format → archive → push → create_pr → code-review
```

### `build_prompt.py`
- `ff` step: simple `/opsx:ff {title_slug}` (no QA subagent)
- `revise` step: unchanged
- `prd` and `apply` steps: removed (ValueError raised)
- Branch name: `feat/{ticket_id}` (no `.lower()`)

## Files modified

### gogox-flutter repo
- NEW: `.claude/agents/pm-agent.md`
- NEW: `.claude/agents/designer-agent.md`
- NEW: `.claude/agents/dev-agent.md`

### slack-agents repo
- MODIFIED: `agent.js` — orchestrator, buildTicketContext, runSkill agent support, stripMention in handlers, confirmation reaction
- MODIFIED: `build_prompt.py` — removed prd/apply, fixed branch name, simplified ff
