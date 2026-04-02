# Tasks: Reliability Improvements + Skip Existing Artifacts

## Task 1: Add `safetyCommit` helper
- Reusable function: `git add -A`, check dirty, commit with label
- Log when safety net triggers

## Task 2: Skip existing artifacts in `prd` flow
- After `ensureWorktreeInteractive`, check `openspec/changes/` for non-archive dirs
- If found: post "artifacts already exist, skipping" → jump to requester notification
- If not: run PM agent as before

## Task 3: Skip existing artifacts in `ff` flow
- Same check after `ensureWorktreeInteractive`
- If found: post "skipping PM agent" → jump to `ffTickets.add` + mention Dev Bot
- If not: run PM agent as before

## Task 4: `runSkill` timeout auto-resume
- Detect timeout errors (`err.message.includes("timed out")`)
- On timeout: `safetyCommit` + push + switch to `--resume` mode
- Max 3 resume attempts per skill
- Post progress: "timed out, resuming session... (attempt N/3)"

## Task 5: Progressive push after each skill
- After `opsx:apply`: `safetyCommit` + `git push`
- After `/commit`: `safetyCommit` + `git push`
- After `/format`: `safetyCommit` + `git push`

## Task 6: Safety commit on failure in `runDevJob`
- In catch block: if worktree exists, `safetyCommit` + push
- Post "Partial work committed and pushed to branch"

## Task 7: Strip mention in message handlers
- PM confirmation handler: `stripMention(message.text).toLowerCase()`
- Dev confirmation handler: same
- Dev approval handler: `stripMention(message.text)`

## Task 8: Confirmation reaction on user's reply
- `waitForConfirmation` returns `{ choice, messageTs }`
- Confirmation handlers resolve with `{ choice, messageTs: message.ts }`
- `ensureWorktreeInteractive` adds ✅ on `confirmTs`

## Task 9: Fix "QA + Dev" text
- Change to "Generating artifacts..."

## Task 10: Increase timeout values
- `CLAUDE_TIMEOUT_MS`: 45 min
- `JOB_TIMEOUT_MS`: 60 min
