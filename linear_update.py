#!/usr/bin/env python3
"""Assign a Linear ticket to the current viewer and transition it to In Progress."""

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

VIEWER_QUERY = """
query {
  viewer {
    id
  }
}
"""

STATES_QUERY = """
query GetStates($teamId: String!) {
  team(id: $teamId) {
    states {
      nodes {
        id
        name
        type
      }
    }
  }
}
"""

UPDATE_MUTATION = """
mutation UpdateIssue($id: String!, $assigneeId: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { assigneeId: $assigneeId, stateId: $stateId }) {
    success
  }
}
"""


def graphql(api_key: str, query: str, variables: dict = None) -> dict:
    payload = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
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

    return data.get("data", {})


def get_in_progress_state_id(api_key: str, team_id: str) -> str:
    data = graphql(api_key, STATES_QUERY, {"teamId": team_id})
    nodes = data.get("team", {}).get("states", {}).get("nodes", [])
    started_states = [n for n in nodes if n.get("type") == "started"]
    if not started_states:
        raise RuntimeError(f"No 'started' state found for team {team_id}")
    # Prefer state named "In Progress" if multiple started states exist
    preferred = [s for s in started_states if s["name"] == "In Progress"]
    return preferred[0]["id"] if preferred else started_states[0]["id"]


def main():
    if len(sys.argv) < 2:
        print("Usage: linear_update.py <TICKET_ID>", file=sys.stderr)
        sys.exit(1)

    ticket_id = sys.argv[1].strip().upper()
    input_path = f"/tmp/ticket-{ticket_id}.json"

    if not os.path.exists(input_path):
        print(f"Error: {input_path} not found. Run fetch_ticket.py first.", file=sys.stderr)
        sys.exit(1)

    with open(input_path) as f:
        ticket = json.load(f)

    linear_id = ticket.get("linear_id")
    team_id = ticket.get("team_id")
    if not linear_id or not team_id:
        print(f"Error: ticket JSON is missing 'linear_id' or 'team_id'.", file=sys.stderr)
        sys.exit(1)

    api_key = os.environ.get("LINEAR_API_KEY")
    if not api_key:
        raise ValueError("LINEAR_API_KEY environment variable is required")

    try:
        # 1. Get viewer ID
        viewer_data = graphql(api_key, VIEWER_QUERY)
        viewer_id = viewer_data["viewer"]["id"]

        # 2. Get "In Progress" state ID for the team
        state_id = get_in_progress_state_id(api_key, team_id)

        # 3. Assign to self and transition to In Progress
        result = graphql(api_key, UPDATE_MUTATION, {
            "id": linear_id,
            "assigneeId": viewer_id,
            "stateId": state_id,
        })
        success = result.get("issueUpdate", {}).get("success", False)
        if success:
            print(f"Successfully assigned {ticket_id} to self and transitioned to In Progress.")
        else:
            print(f"Error: issueUpdate returned success=false for {ticket_id}.")
            sys.exit(1)

    except Exception as e:
        print(f"Error updating {ticket_id}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
