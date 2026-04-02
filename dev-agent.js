"use strict";

require("dotenv").config();

const { App } = require("@slack/bolt");
const PQueue = require("p-queue").default;
const {
  CLAUDE_BIN, FLUTTER_BIN, REPO_ROOT, WORKTREE_BASE, CLAUDE_TIMEOUT_MS,
  FETCH_TICKET_PY, BUILD_PROMPT_PY, LINEAR_UPDATE_PY, CREATE_PR_PY,
  postThread, run, runAsync, getLatestSessionId, cleanupWorktree,
  spawnSync, fs, path,
} = require("./shared");

const SLACK_BOT_TOKEN = process.env.DEV_SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.DEV_SLACK_APP_TOKEN;
if (!SLACK_BOT_TOKEN) throw new Error("DEV_SLACK_BOT_TOKEN is required");
if (!SLACK_APP_TOKEN) throw new Error("DEV_SLACK_APP_TOKEN is required");

const app = new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true });
const queue = new PQueue({ concurrency: 1 });

const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const DEDUP_TTL_MS = 10 * 60 * 1000;
const recentTickets = new Map();
const pendingApprovals = new Map();

function waitForApproval(threadTs, timeoutMs = 60 * 60 * 1000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(threadTs);
      resolve({ approved: false, extra: "" });
    }, timeoutMs);
    pendingApprovals.set(threadTs, { resolve: (val) => { clearTimeout(timer); resolve(val); } });
  });
}

function isRecentlyQueued(ticketId) {
  const ts = recentTickets.get(ticketId);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) { recentTickets.delete(ticketId); return false; }
  return true;
}

// --- Main job runner ---
async function runJob(ticketId, channelId, threadTs, client) {
  const branch = `feat/${ticketId.toLowerCase()}`;
  const worktreePath = path.join(WORKTREE_BASE, ticketId);

  let jobTimedOut = false;
  const jobTimer = setTimeout(() => { jobTimedOut = true; }, JOB_TIMEOUT_MS);

  try {
    // Step 1: Fetch ticket + assign to self + In Progress
    await postThread(client, channelId, threadTs, `Fetching ticket \`${ticketId}\`...`);
    run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });
    run("python3", [LINEAR_UPDATE_PY, ticketId], { env: { ...process.env } });

    if (jobTimedOut) throw new Error("Job timed out");

    // Step 2: Create worktree (detached, no branch yet)
    await postThread(client, channelId, threadTs, `Preparing workspace...`);
    fs.mkdirSync(WORKTREE_BASE, { recursive: true });
    run("git", ["fetch", "origin"], { cwd: REPO_ROOT });
    run("git", ["worktree", "add", "--detach", worktreePath, "origin/trunk"], { cwd: REPO_ROOT });

    if (jobTimedOut) throw new Error("Job timed out");

    // Step 3a: Generate artifacts (PM + Designer + QA → opsx:ff)
    await postThread(client, channelId, threadTs, `Generating artifacts (PM + Designer + QA)...`);
    run("python3", [BUILD_PROMPT_PY, ticketId, worktreePath, "ff"], { env: { ...process.env } });
    const ffPrompt = fs.readFileSync(`/tmp/agent-prompt-${ticketId}-ff.txt`, "utf8");
    const ffOutput = await runAsync(
      CLAUDE_BIN, ["--print", "--dangerously-skip-permissions"],
      { input: ffPrompt, cwd: worktreePath, env: { ...process.env }, timeout: CLAUDE_TIMEOUT_MS }
    );

    if (jobTimedOut) throw new Error("Job timed out");

    // Step 3b: Ask for approval
    const ffSummary = ffOutput.trim().slice(-1500) || "(no output)";
    await postThread(client, channelId, threadTs,
      `Artifacts ready:\n\`\`\`\n${ffSummary}\n\`\`\`\nReply \`approve\` to start implementation, or \`reject\` to cancel.\nYou can also reply \`approve: <extra instructions>\`.`
    );

    const { approved, extra } = await waitForApproval(threadTs);
    if (!approved) {
      await postThread(client, channelId, threadTs, `Cancelled \`${ticketId}\`.`);
      return;
    }

    // Step 4a: Create and push branch
    await postThread(client, channelId, threadTs, `Creating branch \`${branch}\`...`);
    spawnSync("git", ["branch", "-D", branch], { cwd: REPO_ROOT, encoding: "utf8" });
    run("git", ["checkout", "-b", branch], { cwd: worktreePath });
    run("git", ["push", "-u", "origin", branch], { cwd: worktreePath });

    // Helper: run a claude skill with retry
    const runSkill = async (label, prompt, retries = 2) => {
      await postThread(client, channelId, threadTs, `Running \`${label}\`...`);
      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
          const out = await runAsync(
            CLAUDE_BIN, ["--print", "--dangerously-skip-permissions"],
            { input: prompt, cwd: worktreePath, env: { ...process.env }, timeout: CLAUDE_TIMEOUT_MS }
          );
          if (jobTimedOut) throw new Error("Job timed out");
          return out;
        } catch (err) {
          const isTransient = err.message.includes("500") || err.message.includes("Internal server error") || err.message.includes("529");
          if (isTransient && attempt <= retries) {
            const wait = attempt * 15000;
            await postThread(client, channelId, threadTs, `\`${label}\` hit a transient API error, retrying in ${wait / 1000}s... (attempt ${attempt}/${retries})`);
            await new Promise(r => setTimeout(r, wait));
          } else { throw err; }
        }
      }
    };

    // Step 4b: /opsx:apply
    run("python3", [BUILD_PROMPT_PY, ticketId, worktreePath, "apply", extra], { env: { ...process.env } });
    const applyPrompt = fs.readFileSync(`/tmp/agent-prompt-${ticketId}-apply.txt`, "utf8");
    await runSkill("opsx:apply", applyPrompt);

    // Step 5: /commit
    await runSkill("commit", "/commit");

    // Step 6: /format
    await runSkill("format", "/format");

    // Step 7: create PR
    await postThread(client, channelId, threadTs, `Creating PR...`);
    run("python3", [CREATE_PR_PY], { cwd: worktreePath, env: { ...process.env, TICKET_ID: ticketId } });
    if (jobTimedOut) throw new Error("Job timed out");

    const prUrlFile = `/tmp/pr-url-${ticketId}.txt`;
    let prUrl = "";
    if (fs.existsSync(prUrlFile)) { prUrl = fs.readFileSync(prUrlFile, "utf8").trim(); }

    // Step 8: /code-review
    const reviewOut = await runSkill("code-review", "/code-review");
    const reviewTruncated = reviewOut.trim().slice(-2000) || "(no output)";
    await postThread(client, channelId, threadTs, `Code review:\n\`\`\`\n${reviewTruncated}\n\`\`\``);

    const successMsg = prUrl
      ? `All done! PR ready: ${prUrl}`
      : `All done! \`${ticketId}\` implementation complete.`;
    await postThread(client, channelId, threadTs, successMsg);

    const sessionId = getLatestSessionId();
    if (sessionId) {
      await postThread(client, channelId, threadTs,
        `To continue in terminal:\n\`\`\`\ncd ${worktreePath}\nclaude --resume ${sessionId}\n\`\`\``
      );
    }
  } catch (err) {
    console.error(`[${ticketId}] Job failed:`, err.message);
    await postThread(client, channelId, threadTs, `Failed on \`${ticketId}\`: ${err.message}`);
  } finally {
    clearTimeout(jobTimer);
    recentTickets.delete(ticketId);
    cleanupWorktree(worktreePath);
  }
}

// --- Approval reply handler ---
app.message(async ({ message, next }) => {
  if (!message.thread_ts) return await next();
  const pending = pendingApprovals.get(message.thread_ts);
  if (!pending) return await next();
  const text = (message.text || "").trim();
  const approveMatch = text.match(/^approve[:\s]+([\s\S]+)/i) || (["approve","yes","ok","y"].includes(text.toLowerCase()) ? [null, ""] : null);
  const isReject = ["reject","no","cancel","n"].includes(text.toLowerCase());

  if (approveMatch) {
    pendingApprovals.delete(message.thread_ts);
    pending.resolve({ approved: true, extra: (approveMatch[1] || "").trim() });
  } else if (isReject) {
    pendingApprovals.delete(message.thread_ts);
    pending.resolve({ approved: false, extra: "" });
  }
  await next();
});

// --- "CAF-123" handler ---
app.message(/^([A-Z]+-\d+)$/, async ({ message, client }) => {
  const ticketId = message.text.trim();
  const channelId = message.channel;
  const threadTs = message.ts;

  try { await client.reactions.add({ channel: channelId, timestamp: threadTs, name: "eyes" }); } catch (_) {}

  if (isRecentlyQueued(ticketId)) {
    await postThread(client, channelId, threadTs, `Already working on \`${ticketId}\`. Check the thread above.`);
    return;
  }

  recentTickets.set(ticketId, Date.now());
  await postThread(client, channelId, threadTs, `Queued \`${ticketId}\` — I'll update this thread as I go.`);
  queue.add(() => runJob(ticketId, channelId, threadTs, client));
});

(async () => {
  await app.start();
  console.log("Dev agent is running (Socket Mode)");
})();
