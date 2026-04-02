# Design: Reliability Improvements + Skip Existing Artifacts

## 1. Skip existing artifacts

Both `prd` and `ff` handlers check after `ensureWorktreeInteractive`:

```js
const changesDir = path.join(worktreePath, "openspec", "changes");
const existingArtifacts = fs.existsSync(changesDir) && fs.readdirSync(changesDir)
  .filter(d => d !== "archive" && d !== ".gitkeep" && fs.statSync(path.join(changesDir, d)).isDirectory());
const hasArtifacts = existingArtifacts && existingArtifacts.length > 0;
```

- `prd`: if `hasArtifacts` → post "already exist, skipping" → jump to requester notification
- `ff`: if `hasArtifacts` → post "already exist, skipping PM" → jump to `ffTickets.add` + mention Dev Bot

## 2. `safetyCommit` helper

```js
function safetyCommit(worktreePath, ticketId, label) {
  spawnSync("git", ["add", "-A"], { cwd: worktreePath });
  const dirty = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: worktreePath }).status !== 0;
  if (dirty) {
    console.log(`[${ticketId}] Safety net (${label}): committing uncommitted changes`);
    spawnSync("git", ["commit", "-m", `feat(${ticketId}): safety commit ${label}`], { cwd: worktreePath });
  }
}
```

Called after every `runSkill` step and on failure in catch block.

## 3. `runSkill` with timeout resume

```js
const MAX_RESUMES = 3;
const runSkill = async (label, prompt, retries = 2) => {
  let isResume = false;
  for (let attempt = 1; ...) {
    try {
      const args = isResume
        ? ["--print", "--dangerously-skip-permissions", "--model", "opus", "--resume", sessionName]
        : ["--print", "--dangerously-skip-permissions", "--model", "opus", "--name", sessionName];
      const input = isResume ? "Continue where you left off." : prompt;
      // ... runAsync ...
    } catch (err) {
      if (isTimeout && attempt <= MAX_RESUMES) {
        safetyCommit(worktreePath, ticketId, `${label} timeout`);
        try { run("git", ["push", ...]); } catch (_) {}
        isResume = true;
        continue;
      }
      // ... transient retry / rethrow ...
    }
  }
};
```

## 4. Progressive push

After each skill in `runDevJob`:
```
opsx:apply → safetyCommit → push
/commit    → safetyCommit → push
/format    → safetyCommit → push
archive    → commit → push
create_pr
```

## 5. Safety commit on failure

`runDevJob` catch block:
```js
if (worktreePath && fs.existsSync(worktreePath)) {
  safetyCommit(worktreePath, ticketId, "on failure");
  try { run("git", ["push", ...]); } catch (_) {}
  // post "Partial work committed and pushed"
}
```

## 6. Strip mention in message handlers

All three message handlers (PM confirmation, Dev confirmation, Dev approval) use `stripMention(message.text)` instead of `(message.text || "").trim()`.

## 7. Confirmation reaction on user's reply

`waitForConfirmation` resolves `{ choice, messageTs }`. Confirmation handlers pass `message.ts`. `ensureWorktreeInteractive` adds ✅ on `confirmTs`.

## 8. Timeout values

- `CLAUDE_TIMEOUT_MS`: 28 min → 45 min
- `JOB_TIMEOUT_MS`: 30 min → 60 min

## Files Modified

- `agent.js` — all changes in single file
