#!/usr/bin/env python3
"""Fetch a Linear ticket and write it to /tmp/ticket-{ticket_id}.json."""

import json
import os
import ssl
import sys
import urllib.request
import urllib.error

# macOS Python 3.10 ships without bundled certs; use system keychain
_ssl_ctx = ssl.create_default_context()
try:
    import certifi
    _ssl_ctx = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _ssl_ctx.load_default_certs()

LINEAR_API_ENDPOINT = "https://api.linear.app/graphql"

TERMINAL_STATUSES = {"Done", "Cancelled", "Duplicate"}

QUERY = """
query GetIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    state { name }
    labels { nodes { name } }
    assignee { name }
    team { id }
  }
}
"""


def fetch_ticket(ticket_id: str) -> dict:
    api_key = os.environ.get("LINEAR_API_KEY")
    if not api_key:
        raise ValueError("LINEAR_API_KEY environment variable is required")

    payload = json.dumps({"query": QUERY, "variables": {"id": ticket_id}}).encode("utf-8")
    req = urllib.request.Request(
        LINEAR_API_ENDPOINT,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": api_key,
        },
    )

    try:
        with urllib.request.urlopen(req, context=_ssl_ctx) as response:
            data = json.loads(response.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Linear API HTTP error {e.code}: {e.read().decode()}") from e

    errors = data.get("errors")
    if errors:
        raise RuntimeError(f"Linear API errors: {errors}")

    issue = data.get("data", {}).get("issue")
    if not issue:
        print(f"Error: Ticket {ticket_id} not found in Linear.", file=sys.stderr)
        sys.exit(2)

    status = issue["state"]["name"]
    if status in TERMINAL_STATUSES:
        print(
            f"Error: Ticket {ticket_id} has status '{status}' and cannot be implemented.",
            file=sys.stderr,
        )
        sys.exit(2)

    return {
        "id": issue["identifier"],
        "linear_id": issue["id"],
        "team_id": issue["team"]["id"],
        "title": issue["title"],
        "description": issue.get("description") or "",
        "status": status,
        "labels": [label["name"] for label in issue.get("labels", {}).get("nodes", [])],
        "assignee": (issue.get("assignee") or {}).get("name") or "",
    }


def main():
    if len(sys.argv) < 2:
        print("Usage: fetch_ticket.py <TICKET_ID>", file=sys.stderr)
        sys.exit(1)

    ticket_id = sys.argv[1].strip().upper()
    ticket = fetch_ticket(ticket_id)

    output_path = f"/tmp/ticket-{ticket_id}.json"
    with open(output_path, "w") as f:
        json.dump(ticket, f, indent=2)

    print(f"Ticket written to {output_path}")


if __name__ == "__main__":
    main()
