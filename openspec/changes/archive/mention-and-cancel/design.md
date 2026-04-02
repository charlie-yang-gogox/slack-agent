# Design: Mention-Based Commands + Cancel Support + Worktree Confirmation

## Architecture Changes

### 1. Event Model Switch

**Before:**
```js
pmApp.message(/^prd\s+([A-Z]+-\d+)$/i, handler)
devApp.message(/^(?:dev\s+)?([A-Z]+-\d+)$/i, handler)
```

**After:**
```js
pmApp.event('app_mention', handler)   // all PM commands via mention
devApp.event('app_mention', handler)  // all Dev commands via mention
```

Each handler strips `<@U_BOT_ID>` from the text, then routes to the appropriate command function based on regex matching on the cleaned text.

**Text cleaning:**
```js
function stripMention(text) {
  return text.replace(/^\s*<@[A-Z0-9]+>\s*/i, "").trim();
}
```

**Command routing (PM):**
- `/^prd\s+([A-Z]+-\d+)$/i` → prdHandler
- `/^update$/i` → updateHandler (must be in thread)
- `/^cancel\s+([A-Z]+-\d+)$/i` → cancelHandler

**Command routing (Dev):**
- `/^(?:dev\s+)?([A-Z]+-\d+)$/i` → devHandler
- `/^cancel\s+([A-Z]+-\d+)$/i` → cancelHandler

**Kept as `message` listener (no mention needed):**
- `approve` / `reject` — thread replies during the approval flow
- `recreate` / `reuse` — thread replies during worktree confirmation

### 2. Process Tracking for Cancel

**New shared state:**
```js
const activeProcesses = new Map();     // ticketId → { proc, threadTs, channelId }
const cancelledTickets = new Set();    // suppress error messages after cancel
const pendingConfirmations = new Map(); // threadTs → { resolve }
```

**Modified `runAsync`:**
Add an optional `ticketId` parameter. When provided, register the spawned process in `activeProcesses` and remove it on completion (both success and error paths).

```js
function runAsync(cmd, args, opts = {}) {
  // ... existing spawn logic ...
  if (opts.ticketId) {
    activeProcesses.set(opts.ticketId, { proc, threadTs: opts.threadTs, channelId: opts.channelId });
  }
  proc.on("error", () => { if (opts.ticketId) activeProcesses.delete(opts.ticketId); });
  proc.on("close", () => { if (opts.ticketId) activeProcesses.delete(opts.ticketId); });
}
```

**Cancel handler:**
```js
async function handleCancel(ticketId, channelId, threadTs, client) {
  const active = activeProcesses.get(ticketId);
  if (!active) {
    await postThread(client, channelId, threadTs, `No running job found for \`${ticketId}\`.`);
    return;
  }
  active.proc.kill("SIGTERM");
  cancelledTickets.add(ticketId);
  activeProcesses.delete(ticketId);
  recentTickets.delete(ticketId);
  pendingApprovals.delete(active.threadTs || threadTs);

  // Force-remove local worktree and branch
  const worktreePath = path.join(WORKTREE_BASE, ticketId);
  const branch = `feat/${ticketId.toLowerCase()}`;
  if (fs.existsSync(worktreePath)) {
    spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: REPO_ROOT });
  }
  spawnSync("git", ["branch", "-D", branch], { cwd: REPO_ROOT });

  await postThread(client, channelId, threadTs, `Cancelled \`${ticketId}\`. Worktree and branch \`${branch}\` removed.`);
}
```

### 3. Isolation Guarantee

- `activeProcesses` is keyed by `ticketId`, not thread or channel.
- `kill("SIGTERM")` targets only the specific `ChildProcess` for that ticket.
- Other entries in `activeProcesses` are untouched.
- The job's `catch` block in `runDevJob` / PM handler will fire (process exits non-zero after SIGTERM). The `cancelledTickets` Set lets the error handler distinguish cancellation from real failures and skip posting a misleading error message.

### 4. Worktree Existence Confirmation

**`ensureWorktreeInteractive(ticketId, channelId, threadTs, client)`:**

An async wrapper around `ensureWorktree` that checks if a worktree already exists on the correct branch. If so, posts a message and waits for user reply.

```js
async function ensureWorktreeInteractive(ticketId, channelId, threadTs, client) {
  const branch = `feat/${ticketId.toLowerCase()}`;
  const worktreePath = path.join(WORKTREE_BASE, ticketId);

  if (fs.existsSync(worktreePath)) {
    // Check if on correct branch
    const currentBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath }).stdout.trim();
    if (currentBranch === branch) {
      // Ask user
      await postThread(client, channelId, threadTs,
        `Worktree for \`${ticketId}\` already exists on branch \`${branch}\`.\n` +
        `Reply \`recreate\` to delete and rebuild, or \`reuse\` to continue with existing.`
      );
      const choice = await waitForConfirmation(threadTs); // 5 min timeout, defaults to "reuse"
      if (choice === "recreate") {
        spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: REPO_ROOT });
        spawnSync("git", ["branch", "-D", branch], { cwd: REPO_ROOT });
      }
    }
  }
  return ensureWorktree(ticketId); // creates fresh or reuses
}
```

**`waitForConfirmation(threadTs)`:**
Same promise pattern as `waitForApproval`. 5 minute timeout, defaults to `"reuse"`.

**Message handlers (both PM and Dev):**
```js
app.message(async ({ message, next }) => {
  if (!message.thread_ts) return await next();
  const pending = pendingConfirmations.get(message.thread_ts);
  if (!pending) return await next();
  const text = (message.text || "").trim().toLowerCase();
  if (text === "recreate") { pending.resolve("recreate"); }
  else if (text === "reuse") { pending.resolve("reuse"); }
  await next();
});
```

### 5. PM Cancel Support

PM bot also gets cancel support via `@PM Bot cancel CAF-123` using the same `activeProcesses` map and `handleCancel` function, since PM and Dev share the same process.

## Files Modified

- `agent.js` — event model, process tracking, cancel command, worktree confirmation, error handling
