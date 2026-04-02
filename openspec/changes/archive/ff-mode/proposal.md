# Proposal: FF (Fast-Forward) Mode

## Problem

Current workflow requires multiple human interactions:
1. `@PMBot prd CAF-XXX` → review artifacts → `@DevBot dev CAF-XXX` → `approve` → wait for PR

Users sometimes want a fully automated end-to-end flow: trigger once, get a PR.

## Proposed Solution

Add `@PMBot ff CAF-XXX` command that runs the full PM → Dev pipeline automatically:

1. PM Bot generates PRD + artifacts (same as `prd`)
2. PM Bot posts artifacts to thread (same as `prd`)
3. PM Bot mentions Dev Bot in thread: `<@DevBot> dev CAF-XXX`
4. Dev Bot's `app_mention` handler picks up the mention and starts dev flow
5. Dev Bot detects ff mode → skips `approve`/`reject` and worktree confirmation
6. Dev Bot implements → commit → push → create PR → code review
7. Dev Bot posts PR link

Supports extra instructions: `@PMBot ff CAF-XXX: focus on error handling` — text after colon is passed to the dev phase as apply instructions.

### Bot-to-bot interaction

PM Bot posts a real Slack message mentioning Dev Bot. Dev Bot's `app_mention` event fires and handles it like any other mention. This gives full visibility in Slack — humans can see the handoff happen in the thread.

### Worktree confirmation

FF mode asks `recreate`/`reuse` during PM phase. Dev phase skips worktree confirmation (PM just set it up).

### Bot User IDs

Retrieved automatically at startup via `auth.test()` — no env variables needed.

## Success Criteria

- `@PMBot ff CAF-XXX` produces a PR with no further human input (except worktree confirmation if needed)
- All progress updates visible in thread
- Artifacts posted to thread before dev starts
- PM visibly mentions Dev Bot in Slack thread for handoff
- Dev phase uses the same worktree and artifacts created by PM
- Extra instructions via `@PMBot ff CAF-XXX: <instructions>` are passed to dev apply phase
