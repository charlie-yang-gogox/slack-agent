# TODOs

## Phase 2: Web Dashboard Action Triggers

**What:** Add POST endpoints for triggering/cancelling/approving jobs from the browser.

**Why:** Phase 1 gives visibility (read-only). Phase 2 gives control. Teammates can interact with the agent from the web without needing Slack.

**Scope:**
- POST /api/jobs/ff, /api/jobs/dev, /api/jobs/prd (returns 202 with jobId)
- POST /api/jobs/cancel (returns 200)
- POST /api/approvals/:ticketId/approve, /reject (first-wins with Slack)
- Actions tab in public/index.html
- JobContext adapter pattern (decouple Slack-specific context from core job logic)

**Depends on:** Phase 1 shipped and validated with a real user.

**Design doc:** ~/.gstack/projects/charlie-yang-gogox-slack-agent/yangchenghao-feat/dev-web-monitor-design-20260403-164132.md

---

## Auth: Web Dashboard Authentication

**What:** Add authentication to the web dashboard when it's exposed beyond localhost.

**Why:** The dashboard exposes internal state (ticket IDs, channel IDs, process info). No auth is fine for localhost, but port-forwarding or shared machines need protection.

**Options:** Basic auth (simplest), Slack OAuth (integrates with existing Slack identity).

**Depends on:** Dashboard being deployed beyond localhost.
