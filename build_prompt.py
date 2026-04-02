#!/usr/bin/env python3
"""Read /tmp/ticket-{ticket_id}.json and write a Claude Code prompt to /tmp/agent-prompt-{ticket_id}.txt."""

import json
import os
import re
import sys


def slugify(text: str) -> str:
    """Convert a title to a lowercase hyphenated slug."""
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"[\s]+", "-", text.strip())
    return text


CONSTRAINTS = """
## Constraints

- Only modify files under `lib/`, `test/`, or `openspec/`
- Follow existing patterns in `lib/features/` when adding new features
- Use `AppColors` for all colours — never hardcode hex values
- Do NOT push to remote; the orchestrator handles that
- Stage and commit all changes with a descriptive commit message before finishing
- You are running in fully autonomous mode with all permissions granted
- Do NOT ask for permission or approval to read, write, or edit any file
- Do NOT ask the user to confirm anything — just do it
- If a tool call is needed, execute it immediately without asking
"""

PREAMBLE = """You are a senior Flutter developer working on gogox-client-flutter.

Ticket: {ticket_id} — {title}{description_section}

The branch `{branch}` has already been checked out and pushed to origin. All your commits will land on this branch.

You are operating inside a git worktree at: `{worktree_path}`
This is NOT the main repo clone — it is an isolated worktree. Treat it as your working directory for all file edits, git operations, and Flutter commands.
"""


def build_prompt(ticket: dict, worktree_path: str, step: str = "ff", extra_instructions: str = "") -> str:
    ticket_id = ticket["id"]
    title = ticket["title"]
    description = ticket.get("description", "").strip()
    branch = f"feat/{ticket_id.lower()}"
    title_slug = slugify(title)

    description_section = (
        f"\n\nDescription:\n{description}" if description else ""
    )

    preamble = PREAMBLE.format(
        ticket_id=ticket_id,
        title=title,
        description_section=description_section,
        branch=branch,
        worktree_path=worktree_path,
    )

    if step == "ff":
        task = f"""## Your task

Before generating artifacts, spawn a QA subagent using the Agent tool:

### QA Subagent
Spawn a subagent with subagent_type `general-purpose`, model `sonnet`, and ask it to:
- Read the ticket details above
- Run `/generate-test-cases` to create a structured test plan
- Return the test cases as structured markdown

Once the QA subagent has returned, run `/opsx:ff {title_slug}` — incorporating the test cases as context.

Do NOT run `/opsx:apply` yet — stop after artifacts are created.
"""
    elif step == "prd":
        task = f"""## Your task

You are acting as a Product Manager. Create OpenSpec artifacts for this ticket.

### Step 1: Spawn two subagents in parallel using the Agent tool

**PM Subagent** — subagent_type `PM`, model `sonnet`:
- Read the ticket details and codebase
- Produce a PRD: problem statement, user stories, acceptance criteria, edge cases, out-of-scope
- Return as structured markdown

**Designer Subagent** — subagent_type `Designer`, model `sonnet`:
- Read the ticket details
- Provide UX guidance: screen flow, component structure, interaction patterns, existing components from `lib/` to reuse
- Return as structured markdown

### Step 2: Generate OpenSpec artifacts

Once both subagents return, run `/opsx:ff {title_slug}` — incorporate the PRD and design spec as context.

This creates the OpenSpec artifacts: proposal.md, design.md, specs, and tasks.

### Step 3: Output summary

After `/opsx:ff` completes, output a summary listing:
- Each artifact file created and a one-line description
- All acceptance criteria (numbered)
- Out-of-scope items

Do NOT run `/opsx:apply`. Stop after artifacts are created.
"""
    elif step == "revise":
        task = f"""## Your task

You are acting as a Product Manager. A PRD was previously generated for this ticket, and the team has left feedback in a Slack thread.

Here is the Slack thread conversation (PRD + feedback):

---
{extra_instructions}
---

Your job:
1. Read the existing OpenSpec artifacts in `openspec/changes/`
2. Read through the Slack thread feedback above
3. Update the artifact files (proposal.md, design.md, specs, tasks) to incorporate the feedback
4. Use the Edit tool to modify the actual files — do NOT just output text
5. After editing, output a brief changelog listing what you changed and why
"""
    else:  # apply
        extra_section = f"\n## Additional instructions from reviewer\n{extra_instructions}\n" if extra_instructions else ""
        task = f"""## Your task

You MUST use the OpenSpec workflow. This is mandatory — do not skip it or implement code without it.

1. Run `/opsx:apply` — this skill reads the tasks from `openspec/changes/` and guides you through each task step by step
2. Follow every instruction from `/opsx:apply` precisely — it will tell you which files to edit and what code to write
3. Write actual production Dart code for every task. Every task must result in real file changes.
4. After `/opsx:apply` completes all tasks, run `/opsx:verify` to confirm implementation matches the specs
5. After verification, run the tests: `flutter test`
6. Stage all changes with `git add -A` and commit with a descriptive message

Do NOT implement code without running `/opsx:apply` first.
Do NOT stop after analysis or planning.
Do NOT skip `/opsx:verify` after implementation.
{extra_section}"""

    return preamble + task + CONSTRAINTS


def main():
    if len(sys.argv) < 3:
        print("Usage: build_prompt.py <TICKET_ID> <WORKTREE_PATH> [ff|apply]", file=sys.stderr)
        sys.exit(1)

    ticket_id = sys.argv[1].strip().upper()
    worktree_path = sys.argv[2].strip()
    step = sys.argv[3].strip() if len(sys.argv) > 3 else "ff"
    extra = sys.argv[4].strip() if len(sys.argv) > 4 else ""
    input_path = f"/tmp/ticket-{ticket_id}.json"

    if not os.path.exists(input_path):
        print(f"Error: {input_path} not found. Run fetch_ticket.py first.", file=sys.stderr)
        sys.exit(1)

    with open(input_path) as f:
        ticket = json.load(f)

    prompt = build_prompt(ticket, worktree_path, step, extra)

    output_path = f"/tmp/agent-prompt-{ticket_id}-{step}.txt"
    with open(output_path, "w") as f:
        f.write(prompt)

    print(f"Prompt written to {output_path}")


if __name__ == "__main__":
    main()
