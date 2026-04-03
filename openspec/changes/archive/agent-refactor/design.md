# Design: Move PM/Dev Agent Definitions to gogox-flutter Repo

## 1. pm-agent.md

Located at `gogox-flutter/.claude/agents/pm-agent.md`.

Replaces `build_prompt.py` `prd` step. Contains:
- PM role definition
- Step 1: spawn PM subagent (sonnet) + Designer subagent (sonnet) in parallel
- Step 2: run `/opsx:ff {title_slug}` with both outputs as context
- Step 3: output summary
- All CONSTRAINTS from build_prompt.py (only modify lib/test/openspec, use AppColors, etc.)

Input via stdin: ticket context (ticket_id, title, description, branch, worktree_path) as structured text.

## 2. dev-agent.md

Located at `gogox-flutter/.claude/agents/dev-agent.md`.

Replaces `build_prompt.py` `apply` step. Contains:
- Dev role definition
- Step 1: `/opsx:apply`
- Step 2: `/opsx:verify`
- Step 3: `flutter test`
- Step 4: `git add -A` + commit
- All CONSTRAINTS

Input via stdin: ticket context + optional extra instructions from reviewer.

## 3. agent.js changes

### PM flows (prd, ff)

**Before:**
```js
run("python3", [BUILD_PROMPT_PY, ticketId, worktreePath, "prd"]);
const prdPrompt = fs.readFileSync(`/tmp/agent-prompt-${ticketId}-prd.txt`, "utf8");
await runAsync(CLAUDE_BIN, ["--print", "--dangerously-skip-permissions", "--name", `${ticketId}-prd`],
  { input: prdPrompt, cwd: worktreePath, ... });
```

**After:**
```js
const ticketContext = buildTicketContext(ticketId, worktreePath);
await runAsync(CLAUDE_BIN, ["--print", "--dangerously-skip-permissions", "--agent", "pm-agent", "--name", `${ticketId}-prd`],
  { input: ticketContext, cwd: worktreePath, ... });
```

### Dev flow (apply)

**Before:**
```js
run("python3", [BUILD_PROMPT_PY, ticketId, worktreePath, "apply", applyExtra]);
const applyPrompt = fs.readFileSync(`/tmp/agent-prompt-${ticketId}-apply.txt`, "utf8");
await runSkill("opsx:apply", applyPrompt);
```

**After:**
```js
const ticketContext = buildTicketContext(ticketId, worktreePath, applyExtra);
await runSkill("dev-agent", ticketContext);
```

### New helper in agent.js

```js
function buildTicketContext(ticketId, worktreePath, extraInstructions = "") {
  const ticketPath = `/tmp/ticket-${ticketId}.json`;
  const ticket = JSON.parse(fs.readFileSync(ticketPath, "utf8"));
  const branch = `feat/${ticketId}`;
  let context = `Ticket: ${ticketId} — ${ticket.title}\n`;
  if (ticket.description) context += `\nDescription:\n${ticket.description}\n`;
  context += `\nBranch: ${branch}\nWorktree: ${worktreePath}\n`;
  if (extraInstructions) context += `\n## Additional instructions\n${extraInstructions}\n`;
  return context;
}
```

### runSkill change

`runSkill` label is used as both display name and `--name` for session. For agent-based runs, use `--agent` flag:

```js
const runSkill = async (label, prompt, retries = 2) => {
  const sessionName = `${ticketId}-${label}`;
  const isAgent = ["pm-agent", "dev-agent"].includes(label);
  const baseArgs = isAgent
    ? ["--print", "--dangerously-skip-permissions", "--model", "opus", "--agent", label, "--name", sessionName]
    : ["--print", "--dangerously-skip-permissions", "--model", "opus", "--name", sessionName];
  // ... rest unchanged
};
```

## 4. build_prompt.py changes

- Remove `prd` and `apply` branches from `build_prompt()`
- Fix line 47: `branch = f"feat/{ticket_id}"` (remove `.lower()`)
- Keep `ff` and `revise` steps

## Files Modified

- `gogox-flutter/.claude/agents/pm-agent.md` (NEW)
- `gogox-flutter/.claude/agents/dev-agent.md` (NEW)
- `slack-agents/agent.js`
- `slack-agents/build_prompt.py`
