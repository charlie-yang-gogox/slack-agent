# TODOs

## ~~Phase 2: Web Dashboard Action Triggers~~ DONE

Implemented in Phase 2 commit. POST endpoints, Actions tab, first-wins approval semantics.

---

## Auth: Web Dashboard Authentication

**What:** Add authentication to the web dashboard when it's exposed beyond localhost.

**Why:** The dashboard exposes internal state (ticket IDs, channel IDs, process info). No auth is fine for localhost, but port-forwarding or shared machines need protection.

**Options:** Basic auth (simplest), Slack OAuth (integrates with existing Slack identity).

**Depends on:** Dashboard being deployed beyond localhost.
