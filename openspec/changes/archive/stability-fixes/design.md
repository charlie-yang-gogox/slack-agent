# Design: Stability & UX Fixes

## 1. Ignore stale events on startup

```js
const startupTs = Date.now() / 1000;
```

Both `app_mention` handlers check at the top:
```js
if (parseFloat(event.ts) < startupTs) return;
```

Slack `event.ts` is a Unix timestamp string (e.g., `"1712000000.000100"`). Events sent before the process started are silently dropped.

## 2. Cancel race condition — early exit checks

Add `cancelledTickets.has(ticketId)` checks at key points before and after synchronous `run()` calls:

- **prd handler**: before and after `build_prompt.py`
- **ff handler**: before and after `build_prompt.py`
- **runDevJob**: before `fetch_ticket.py` and after `linear_update.py`

These throw `new Error("Cancelled")` which is caught by the existing catch block that checks `cancelledTickets.has(ticketId)` and returns silently.

## 3. Cancel reaction

`handleCancel` receives `messageTs` parameter and adds ❌ reaction:
```js
async function handleCancel(ticketId, channelId, threadTs, messageTs, client) {
  try { await client.reactions.add({ channel: channelId, timestamp: messageTs, name: "x" }); } catch (_) {}
  // ...
}
```

All callers updated to pass `messageTs`.

## 4. Socket Mode keepalive

Both Slack apps configured with ping timeouts:
```js
const pmApp = new App({
  // ...
  socketModeOptions: { clientPingTimeout: 30000, serverPingTimeout: 30000 },
});
```

Sends WebSocket ping every 30 seconds to prevent idle disconnection during long Claude CLI runs.

## 5. Heartbeat logging

Inside `runAsync`, when `opts.ticketId` is provided, start a 2-minute interval timer:
```js
const heartbeat = setInterval(() => {
  console.log(`[${opts.ticketId}] still running... (${elapsed}s elapsed)`);
}, 2 * 60 * 1000);
```

Cleared on process `close` event.

## 6. Archive openspec + commit before PR

Before `git push` and `create_pr.py` in `runDevJob`:

1. Move all dirs in `openspec/changes/` (except `archive/` and `.gitkeep`) to `openspec/changes/archive/`
2. `git add -A`
3. If staged changes exist (`git diff --cached --quiet` exits non-zero), commit with `chore: archive openspec artifacts for {ticketId}`
4. Then push and run `create_pr.py`

This ensures a clean working tree for `dart format`/`dart fix`/`flutter analyze`.

## 7. Worktree recreate/reuse confirmation reaction

`ensureWorktreeInteractive` adds ✅ reaction after receiving `recreate`/`reuse` reply, before proceeding.

## Files Modified

- `agent.js` — all changes in single file
