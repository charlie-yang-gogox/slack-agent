"use strict";

require("dotenv").config();

const { App } = require("@slack/bolt");
const PQueue = require("p-queue").default;
const {
  CLAUDE_BIN, REPO_ROOT, CLAUDE_TIMEOUT_MS,
  FETCH_TICKET_PY, BUILD_PROMPT_PY,
  postThread, run, runAsync, getLatestSessionId, fs,
} = require("./shared");

const SLACK_BOT_TOKEN = process.env.PM_SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.PM_SLACK_APP_TOKEN;
if (!SLACK_BOT_TOKEN) throw new Error("PM_SLACK_BOT_TOKEN is required");
if (!SLACK_APP_TOKEN) throw new Error("PM_SLACK_APP_TOKEN is required");

const app = new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true });
const queue = new PQueue({ concurrency: 1 });

// --- "prd CAF-123" handler ---
app.message(/^prd\s+([A-Z]+-\d+)$/i, async ({ message, client }) => {
  const ticketId = message.text.replace(/^prd\s+/i, "").trim().toUpperCase();
  const channelId = message.channel;
  const threadTs = message.ts;

  try { await client.reactions.add({ channel: channelId, timestamp: threadTs, name: "memo" }); } catch (_) {}
  await postThread(client, channelId, threadTs, `Generating PRD for \`${ticketId}\`...`);

  queue.add(async () => {
    try {
      run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });

      run("python3", [BUILD_PROMPT_PY, ticketId, REPO_ROOT, "prd"], { env: { ...process.env } });
      const prdPrompt = fs.readFileSync(`/tmp/agent-prompt-${ticketId}-prd.txt`, "utf8");

      await postThread(client, channelId, threadTs, `PM agent is working...`);
      const prdOutput = await runAsync(
        CLAUDE_BIN,
        ["--print", "--dangerously-skip-permissions"],
        { input: prdPrompt, cwd: REPO_ROOT, env: { ...process.env }, timeout: CLAUDE_TIMEOUT_MS }
      );

      const prd = prdOutput.trim();
      for (let i = 0; i < prd.length; i += 3500) {
        await postThread(client, channelId, threadTs, prd.slice(i, i + 3500));
      }

      const sessionId = getLatestSessionId();
      if (sessionId) {
        await postThread(client, channelId, threadTs,
          `To continue locally:\n\`\`\`\nclaude --resume ${sessionId}\n\`\`\``
        );
      }
    } catch (err) {
      console.error(`[PRD ${ticketId}] failed:`, err.message);
      await postThread(client, channelId, threadTs, `PRD generation failed: ${err.message}`);
    }
  });
});

(async () => {
  await app.start();
  console.log("PM agent is running (Socket Mode)");
})();
