# Dev Agent (Local Mode)

The dev agent watches a Slack channel for Linear ticket IDs and automatically implements them using Claude Code CLI, then opens a PR — all running locally as a single Node.js process. No GitHub Actions required.

## How it works

A single PM2-managed Node.js process (`index.js`) handles everything:

1. **Slack listener** (Socket Mode) watches for messages matching `[A-Z]+-\d+`
2. When a ticket ID is posted, the bot reacts with :eyes: and enqueues the job
3. An **in-memory queue** (concurrency: 1) runs jobs one at a time
4. Per job, the orchestrator runs each step as a child process and posts thread updates:
   - `fetch_ticket.py` — fetches ticket from Linear
   - `git worktree add` — creates an isolated worktree at `/tmp/agent-ws/{ticket_id}`
   - `git checkout -b feat/{ticket_id}` + `git push` — creates and pushes the branch
   - `build_prompt.py` — writes the Claude prompt to `/tmp/agent-prompt-{ticket_id}.txt`
   - `claude --print --dangerously-skip-permissions --max-turns 80` — implements the ticket
   - `dart format` + `fvm flutter analyze` + `fvm flutter test` — validates the output
   - `create_pr.py` — opens the PR
   - Worktree is removed on completion or failure

## Required env vars

Set these in your shell profile (`~/.zshrc` or `~/.bashrc`) or export them before starting:

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (starts with `xoxb-`) |
| `SLACK_APP_TOKEN` | Slack app-level token for Socket Mode (starts with `xapp-`) |
| `LINEAR_API_KEY` | Linear personal API key (starts with `lin_api_`) |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude Code CLI |
| `GITHUB_TOKEN` | Personal access token (for `create_pr.py` and git push via HTTPS) |

If using SSH for git push, `GITHUB_TOKEN` is only needed by `create_pr.py`.

## Install dependencies

```sh
cd .dev-agent
npm install
```

## Run

Directly:

```sh
node index.js
```

Via PM2 (recommended for persistent background operation):

```sh
npm install -g pm2
pm2 start index.js --name dev-agent
pm2 save
pm2 startup   # follow the printed command to auto-start on login
```

View logs:

```sh
pm2 logs dev-agent
```

## Slack app setup

1. Go to https://api.slack.com/apps and click **Create New App > From scratch**
2. Under **Socket Mode**, enable it and generate an app-level token with the `connections:write` scope — this is your `SLACK_APP_TOKEN`
3. Under **OAuth & Permissions**, add these Bot Token Scopes:
   - `channels:history`
   - `groups:history`
   - `chat:write`
   - `reactions:write`
4. Install the app to your workspace and copy the **Bot User OAuth Token** — this is your `SLACK_BOT_TOKEN`
5. Invite the bot to the channel(s) you want it to monitor: `/invite @YourBotName`

## Prevent Mac from sleeping

The process must stay awake. Run this once (applies while plugged in):

```sh
sudo pmset -c sleep 0
```

To revert:

```sh
sudo pmset -c sleep 1
```

## Test it

1. Start the agent (`node index.js` or `pm2 start index.js --name dev-agent`)
2. Post a ticket ID (e.g. `CAF-203`) as the **only text** in a message in the monitored channel
3. The bot reacts with :eyes: and replies in-thread confirming it was queued
4. Thread updates are posted at each phase; a final message links to the opened PR
