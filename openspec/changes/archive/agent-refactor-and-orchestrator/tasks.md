# Tasks: Agent Refactor — PM/Dev/Designer Agents + Orchestrator

## Task 1: Create pm-agent.md in gogox-flutter ✅
- `.claude/agents/pm-agent.md`
- Sonnet model, read-only tools
- Produces PRD, does not run /opsx:ff

## Task 2: Create designer-agent.md in gogox-flutter ✅
- `.claude/agents/designer-agent.md`
- Sonnet model, read-only tools + Figma MCP
- Provides UX guidance, Figma integration

## Task 3: Create dev-agent.md in gogox-flutter ✅
- `.claude/agents/dev-agent.md`
- Opus model, full tool access
- `/opsx:apply` → `/opsx:verify` → test → commit

## Task 4: Add helpers to agent.js ✅
- `buildTicketContext()` — reads ticket JSON, builds context
- `slugify()` — title to kebab-case
- `runPMPhase()` — orchestrator session with cache-aware prompt

## Task 5: Update PM flows in agent.js ✅
- `prd` handler: `runPMPhase` replaces `build_prompt.py prd`
- `ff` handler: `runPMPhase` replaces `build_prompt.py prd`
- Dev flow artifact generation: `runPMPhase` replaces `build_prompt.py ff`

## Task 6: Update Dev flow in agent.js ✅
- `runSkill("dev-agent", devContext)` replaces `build_prompt.py apply`
- `runSkill` detects agent labels, uses `--agent` flag

## Task 7: Clean up build_prompt.py ✅
- Removed `prd` and `apply` steps
- Fixed branch name uppercase
- Removed QA subagent from `ff` step
- Only `ff` and `revise` remain

## Task 8: Strip mention in message handlers ✅
- PM/Dev confirmation handlers use `stripMention()`
- Dev approval handler uses `stripMention()`

## Task 9: Confirmation reaction on user's reply ✅
- `waitForConfirmation` returns `{ choice, messageTs }`
- Handlers pass `message.ts`
- `ensureWorktreeInteractive` adds ✅ on user's reply

## Task 10: Orchestrator uses opus model ✅
- `runPMPhase` → `--model opus`
- Subagents (pm-agent, designer-agent) use sonnet (defined in .md)
