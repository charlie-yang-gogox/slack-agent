# Design: Mention-Based Commands + Cancel Support

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

**Command routing (Dev):**
- `/^(?:dev\s+)?([A-Z]+-\d+)$/i` → devHandler
- `/^cancel\s+([A-Z]+-\d+)$/i` → cancelHandler

**Kept as `message` listener (no mention needed):**
- `approve` / `reject` — these are thread replies during the approval flow

### 2. Process Tracking for Cancel

**New shared state:**
```js
const activeProcesses = new Map();  // ticketId → { proc: ChildProcess, threadTs, channelId }
```

**Modified `runAsync`:**
Add an optional `ticketId` parameter. When provided, register the spawned process in `activeProcesses` and remove it on completion.

```js
function runAsync(cmd, args, opts = {}) {
  // ... existing spawn logic ...
  if (opts.ticketId) {
    activeProcesses.set(opts.ticketId, { proc, threadTs: opts.threadTs, channelId: opts.channelId });
    proc.on("close", () => activeProcesses.delete(opts.ticketId));
  }
  // ...
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
  activeProcesses.delete(ticketId);
  recentTickets.delete(ticketId);
  pendingApprovals.delete(threadTs);
  await postThread(client, channelId, threadTs, `Cancelled \`${ticketId}\`.`);
}
```

### 3. Isolation Guarantee

- `activeProcesses` is keyed by `ticketId`, not thread or channel.
- `kill("SIGTERM")` targets only the specific `ChildProcess` for that ticket.
- Other entries in `activeProcesses` are untouched.
- The job's `catch` block in `runDevJob` / PM handler will fire (process exits non-zero after SIGTERM). We add a `cancelled` flag so the error handler can distinguish cancellation from real failures and avoid posting a misleading error message.

### 4. PM Cancel Support

PM bot also gets cancel support via `@PM Bot cancel CAF-123` using the same `activeProcesses` map and `handleCancel` function, since PM and Dev share the same process.

## Files Modified

- `agent.js` — main changes: event model, process tracking, cancel command, error handling
