# Design: FF (Fast-Forward) Mode

## Architecture

### Bot User IDs at startup

Both bot user IDs are retrieved via `auth.test()` during startup. No env variables needed.

```js
let pmBotUserId, devBotUserId;

(async () => {
  const [pmAuth, devAuth] = await Promise.all([
    pmApp.client.auth.test(),
    devApp.client.auth.test(),
  ]);
  pmBotUserId = pmAuth.user_id;
  devBotUserId = devAuth.user_id;

  await Promise.all([pmApp.start(), devApp.start()]);
  console.log("PM agent + Dev agent running (Socket Mode)");
})();
```

### New shared state

```js
const ffTickets = new Set(); // ticketIds in ff mode → skip approve + skip worktree confirm in dev
```

Single Set controls all ff-related behavior in the dev flow.

### PM `app_mention` handler — new route

```js
const ffMatch = text.match(/^ff\s+([A-Z]+-\d+)(?:\s*:\s*([\s\S]+))?$/i);
```

Captures ticket ID and optional extra instructions after colon.

**FF handler flow:**

```
@PMBot ff CAF-XXX
→ react with 🚀
→ fetch ticket
→ ensureWorktreeInteractive (asks recreate/reuse if exists)
→ run PM agent (same as prd: build prompt, run Claude, commit, push)
→ post artifacts to thread
→ add ticketId to ffTickets
→ (if extra instructions, store in ffTicketExtras Map)
→ PM posts message in thread: "<@devBotUserId> dev CAF-XXX"
→ Dev Bot's app_mention fires, starts dev flow
→ Dev detects ffTickets.has(ticketId) → skips approve + worktree confirm
→ full dev pipeline → PR
```

### FF with extra instructions

```
@PMBot ff CAF-XXX: focus on error handling
```

Extra instructions are stored in a Map and consumed by Dev:

```js
const ffTicketExtras = new Map(); // ticketId → extra instructions string
```

When Dev starts and `ffTickets.has(ticketId)`:
- Reads `ffTicketExtras.get(ticketId)` as apply extra instructions
- Deletes entry after reading

### Dev `app_mention` handler changes

No new routes needed. Dev's existing handler matches `dev CAF-XXX` or `CAF-XXX`. When triggered:

```js
// Inside dev handler, after ticketId is parsed:
const isFF = ffTickets.has(ticketId);
```

Pass `isFF` to `runDevJob`:

```js
queue.add(() => runDevJob(ticketId, channelId, threadTs, client, threadContext, { isFF }));
```

### Modified `runDevJob`

Add optional `opts` parameter:

```js
async function runDevJob(ticketId, channelId, threadTs, client, threadContext, opts = {})
```

When `opts.isFF` is true:
- Use `ensureWorktree(ticketId)` instead of `ensureWorktreeInteractive` (skip worktree confirm)
- Skip `waitForApproval()` — post "Auto-approved (ff mode), starting implementation..." instead
- Read and consume `ffTicketExtras.get(ticketId)` as apply extra instructions (merged with any thread context)

The rest of the flow (apply → commit → format → push → PR → code-review) is unchanged.

### Worktree handling

- PM phase: `ensureWorktreeInteractive` — asks user if exists
- Dev phase (ff mode): `ensureWorktree` directly — PM just set it up, no need to ask again
- Dev phase (normal mode): `ensureWorktreeInteractive` — asks as before

### Cancel support

`@PMBot cancel CAF-XXX` or `@DevBot cancel CAF-XXX` works as before. If cancel happens during PM phase, PM's mention of Dev never happens. If during dev phase, kills dev process. `ffTickets` and `ffTicketExtras` are cleaned up in error/finally paths.

## Files Modified

- `agent.js` — bot user IDs at startup, `ffTickets` Set, `ffTicketExtras` Map, ff route in PM handler, `runDevJob` opts, dev handler passes `isFF`
