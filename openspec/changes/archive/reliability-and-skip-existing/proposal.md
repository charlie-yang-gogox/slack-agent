# Proposal: Reliability Improvements + Skip Existing Artifacts

## Problems

1. **Duplicate artifact generation**: When worktree is reused and artifacts already exist, PM still re-generates them from scratch — wasting time in both `prd` and `ff` flows.
2. **Implementation code lost on timeout/failure**: Claude CLI times out during `opsx:apply` and all partial work is lost.
3. **Late push**: All commits pushed only at the end — if any step fails midway, nothing is on remote.
4. **Mention not stripped in thread replies**: `@DevBot approve` didn't work because message handlers didn't strip `<@BOT_ID>` prefix.
5. **Confirmation reaction on wrong message**: ✅ reaction was added to the thread parent instead of the user's `reuse`/`recreate` reply.
6. **Misleading "QA + Dev" text**: No QA sub-agent exists.

## Solutions

### 1. Skip existing artifacts in `prd` and `ff` flows
Both flows check `openspec/changes/` for existing artifact directories (excluding `archive/` and `.gitkeep`). If found:
- `prd`: skip generation, post "artifacts already exist", jump to notifying user
- `ff`: skip generation, jump directly to mentioning Dev Bot

### 2. Timeout auto-resume (up to 3 times)
`runSkill` detects timeout errors and automatically resumes the Claude session via `--resume {sessionName}`. Before resuming: safety commit + push partial work. Each resume gets a fresh 45-minute window.

### 3. Progressive push after each skill
After every skill step (`opsx:apply`, `/commit`, `/format`), run `safetyCommit` + `git push`. Partial work is always on remote.

### 4. Safety commit on failure
`runDevJob` catch block runs `safetyCommit` + push before posting failure message. Partial implementation is preserved on remote.

### 5. Strip mention in all message handlers
Confirmation (`recreate`/`reuse`) and approval (`approve`/`reject`) message handlers use `stripMention()` so both `@bot approve` and `approve` work.

### 6. Confirmation reaction on user's reply
`waitForConfirmation` returns `{ choice, messageTs }`. `ensureWorktreeInteractive` adds ✅ reaction on the user's reply message, not the thread parent.

### 7. Fix "QA + Dev" text
Changed to "Generating artifacts..." — no QA sub-agent exists.

## Success Criteria

- Reuse worktree with existing specs → no re-generation, immediate handoff
- Timeout during `opsx:apply` → auto-resume, partial work pushed
- Every skill step → pushed to remote immediately
- `@DevBot approve` and `approve` both work
- ✅ on user's reply message
