# Proposal: UX & Validation Fixes

## Changes

1. **postArtifactsToSlack helper** — Extracted shared function, artifacts posted to Slack on both skip and generate paths (prd + ff)
2. **update command accepts feedback text** — `/^update$/i` → `/^update/i`, `@PM update can you check...` now works
3. **update skips worktree confirmation** — Uses `ensureWorktree` directly (no recreate/reuse question)
4. **Dev thread trigger skips worktree confirmation** — `isFromThread` passed to `runDevJob`, skips interactive prompt
5. **Agent output validation** — `cleanAgentOutput` strips permission error lines, `validateAgentOutput` checks cleaned content ≥10 chars
6. **Validation debug logging** — Logs file/stdout/cleaned char counts for troubleshooting
7. **Agent .md permission statements** — pm-agent, designer-agent, dev-agent all declare full write permissions
8. **Orchestrator permission statement** — Orchestrator prompt declares full write permissions
9. **All sessions log start/done** — `runSkill` and orchestrator print console.log on start and completion
