"use strict";

require("dotenv").config();

const { App } = require("@slack/bolt");
const PQueue = require("p-queue").default;
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- Env vars ---
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
if (!SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is required");
if (!SLACK_APP_TOKEN) throw new Error("SLACK_APP_TOKEN is required");

// --- Constants ---
const CLAUDE_BIN = "/Users/yangchenghao/.local/bin/claude";
const FLUTTER_BIN = "/Users/yangchenghao/flutter/bin/flutter";
const WORKTREE_BASE = path.join(__dirname, "..", "..", "..", "gogox-client-flutter", ".claude", "worktree");

// Ensure flutter bin is in PATH for subprocesses
process.env.PATH = `/Users/yangchenghao/flutter/bin:${process.env.PATH}`;
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLAUDE_TIMEOUT_MS = 28 * 60 * 1000; // 28 minutes

const FETCH_TICKET_PY = path.join(__dirname, "fetch_ticket.py");
const BUILD_PROMPT_PY = path.join(__dirname, "build_prompt.py");
const LINEAR_UPDATE_PY = path.join(__dirname, "linear_update.py");
const CREATE_PR_PY = path.join(__dirname, "..", "..", "..", "gogox-client-flutter", "create_pr.py");

// --- Slack app ---
const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// --- Job queue (concurrency: 1) ---
const queue = new PQueue({ concurrency: 1 });

// --- In-memory dedup ---
const recentTickets = new Map();

// --- Pending approvals: threadTs → { resolve, ticketId } ---
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
  if (Date.now() - ts > DEDUP_TTL_MS) {
    recentTickets.delete(ticketId);
    return false;
  }
  return true;
}

// --- Helpers ---
async function postThread(client, channelId, threadTs, text) {
  try {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text,
    });
  } catch (err) {
    console.error("Failed to post Slack message:", err.message);
  }
}

function run(cmd, args, opts) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(
      `Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}\n${stderr || stdout}`
    );
  }
  return result.stdout || "";
}

function getLatestSessionId() {
  const sessionsDir = path.join(process.env.HOME, ".claude", "sessions");
  try {
    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith(".json"))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.name.replace(".json", "") || null;
  } catch {
    return null;
  }
}

// Async version for long-running commands (avoids blocking the event loop)
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const label = opts.label || path.basename(cmd);
    const proc = spawn(cmd, args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    if (opts.input) proc.stdin.end(opts.input);
    proc.stdout.on("data", (d) => { stdout += d; process.stdout.write(d); });
    proc.stderr.on("data", (d) => { stderr += d; process.stderr.write(d); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (exit ${code}): ${cmd} ${args.join(" ")}\n${(stderr || stdout).trim()}`));
      } else {
        resolve(stdout);
      }
    });
    if (opts.timeout) {
      setTimeout(() => {
        proc.kill();
        reject(new Error(`Command timed out: ${cmd}`));
      }, opts.timeout);
    }
  });
}

function cleanupWorktree(worktreePath) {
  try {
    spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
      encoding: "utf8",
      stdio: "ignore",
      cwd: path.join(__dirname, ".."),
    });
  } catch (_) {}
}

// --- Main job runner ---
async function runJob(ticketId, channelId, threadTs, client) {
  const ticketIdLower = ticketId.toLowerCase();
  const branch = `feat/${ticketIdLower}`;
  const worktreePath = path.join(WORKTREE_BASE, ticketId);
  const repoRoot = path.join(__dirname, "..", "..", "..", "gogox-client-flutter");

  let jobTimedOut = false;
  const jobTimer = setTimeout(() => {
    jobTimedOut = true;
  }, JOB_TIMEOUT_MS);

  try {
    // Step 1: Fetch ticket
    await postThread(client, channelId, threadTs, `Fetching ticket \`${ticketId}\`...`);
    run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });
    run("python3", [LINEAR_UPDATE_PY, ticketId], { env: { ...process.env } });

    if (jobTimedOut) throw new Error("Job timed out");

    // Step 2: Create worktree (detached, no branch yet)
    await postThread(client, channelId, threadTs, `Preparing workspace...`);
    fs.mkdirSync(WORKTREE_BASE, { recursive: true });
    run("git", ["fetch", "origin"], { cwd: repoRoot });
    run("git", ["worktree", "add", "--detach", worktreePath, "origin/trunk"], { cwd: repoRoot });

    if (jobTimedOut) throw new Error("Job timed out");

    // Step 3a: Generate artifacts (opsx:ff)
    await postThread(client, channelId, threadTs, `Generating artifacts...`);
    run("python3", [BUILD_PROMPT_PY, ticketId, worktreePath, "ff"], { env: { ...process.env } });
    const ffPrompt = fs.readFileSync(`/tmp/agent-prompt-${ticketId}-ff.txt`, "utf8");
    const ffOutput = await runAsync(
      CLAUDE_BIN,
      ["--print", "--dangerously-skip-permissions"],
      { input: ffPrompt, cwd: worktreePath, env: { ...process.env }, timeout: CLAUDE_TIMEOUT_MS }
    );

    if (jobTimedOut) throw new Error("Job timed out");

    // Step 3b: Ask for approval
    const ffSummary = ffOutput.trim().slice(-1500) || "(no output)";
    await postThread(
      client, channelId, threadTs,
      `Artifacts ready:\n\`\`\`\n${ffSummary}\n\`\`\`\nReply \`approve\` to start implementation, or \`reject\` to cancel.`
    );

    const { approved, extra } = await waitForApproval(threadTs);
    if (!approved) {
      await postThread(client, channelId, threadTs, `Cancelled \`${ticketId}\`.`);
      return;
    }

    // Step 4a: Create and push branch (only after approval)
    await postThread(client, channelId, threadTs, `Creating branch \`${branch}\`...`);
    spawnSync("git", ["branch", "-D", branch], { cwd: repoRoot, encoding: "utf8" });
    run("git", ["checkout", "-b", branch], { cwd: worktreePath });
    run("git", ["push", "-u", "origin", branch], { cwd: worktreePath });

    // Helper: run a claude skill with retry on transient API errors
    const runSkill = async (label, prompt, retries = 2) => {
      await postThread(client, channelId, threadTs, `Running \`${label}\`...`);
      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
          const out = await runAsync(
            CLAUDE_BIN,
            ["--print", "--dangerously-skip-permissions"],
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
          } else {
            throw err;
          }
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
    run("python3", [CREATE_PR_PY], {
      cwd: worktreePath,
      env: { ...process.env, TICKET_ID: ticketId },
    });
    if (jobTimedOut) throw new Error("Job timed out");

    const prUrlFile = `/tmp/pr-url-${ticketId}.txt`;
    let prUrl = "";
    if (fs.existsSync(prUrlFile)) {
      prUrl = fs.readFileSync(prUrlFile, "utf8").trim();
    }

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
    await postThread(
      client,
      channelId,
      threadTs,
      `Failed on \`${ticketId}\`: ${err.message}`
    );
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
    const extraInstructions = (approveMatch[1] || "").trim();
    pendingApprovals.delete(message.thread_ts);
    pending.resolve({ approved: true, extra: extraInstructions });
  } else if (isReject) {
    pendingApprovals.delete(message.thread_ts);
    pending.resolve({ approved: false, extra: "" });
  }
  await next();
});

// --- PRD command handler: "prd CAF-123" ---
app.message(/^prd\s+([A-Z]+-\d+)$/i, async ({ message, client, context }) => {
  const ticketId = message.text.replace(/^prd\s+/i, "").trim().toUpperCase();
  const channelId = message.channel;
  const threadTs = message.ts;

  try { await client.reactions.add({ channel: channelId, timestamp: threadTs, name: "memo" }); } catch (_) {}

  await postThread(client, channelId, threadTs, `Generating PRD for \`${ticketId}\`...`);

  queue.add(async () => {
    const repoRoot = path.join(__dirname, "..", "..", "..", "gogox-client-flutter");
    try {
      run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });

      run("python3", [BUILD_PROMPT_PY, ticketId, repoRoot, "prd"], { env: { ...process.env } });
      const prdPrompt = fs.readFileSync(`/tmp/agent-prompt-${ticketId}-prd.txt`, "utf8");

      await postThread(client, channelId, threadTs, `PM agent is working...`);
      const prdOutput = await runAsync(
        CLAUDE_BIN,
        ["--print", "--dangerously-skip-permissions"],
        { input: prdPrompt, cwd: repoRoot, env: { ...process.env }, timeout: CLAUDE_TIMEOUT_MS }
      );

      // Post PRD in chunks (Slack has 4000 char limit per message)
      const prd = prdOutput.trim();
      const chunks = [];
      for (let i = 0; i < prd.length; i += 3500) {
        chunks.push(prd.slice(i, i + 3500));
      }
      for (const chunk of chunks) {
        await postThread(client, channelId, threadTs, chunk);
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

// --- Dev agent handler: "CAF-123" ---
app.message(/^([A-Z]+-\d+)$/, async ({ message, client }) => {
  const ticketId = message.text.trim();
  const channelId = message.channel;
  const threadTs = message.ts;

  // React with eyes to acknowledge
  try {
    await client.reactions.add({
      channel: channelId,
      timestamp: threadTs,
      name: "eyes",
    });
  } catch (_) {}

  if (isRecentlyQueued(ticketId)) {
    await postThread(
      client,
      channelId,
      threadTs,
      `Already working on \`${ticketId}\`. Check the thread above.`
    );
    return;
  }

  recentTickets.set(ticketId, Date.now());

  await postThread(
    client,
    channelId,
    threadTs,
    `Queued \`${ticketId}\` — I'll update this thread as I go.`
  );

  queue.add(() => runJob(ticketId, channelId, threadTs, client));
});

// --- Start ---
(async () => {
  await app.start();
  console.log("Dev agent is running (local mode, Socket Mode)");
})();
