"use strict";

require("dotenv").config();

const { App } = require("@slack/bolt");
const PQueue = require("p-queue").default;
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- Constants (from env or defaults) ---
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const FLUTTER_BIN = process.env.FLUTTER_BIN || "flutter";
const REPO_ROOT = process.env.REPO_ROOT;
if (!REPO_ROOT) throw new Error("REPO_ROOT is required (path to your flutter project)");
const WORKTREE_BASE = process.env.WORKTREE_BASE || path.join(REPO_ROOT, ".claude", "worktree");
const CLAUDE_TIMEOUT_MS = 28 * 60 * 1000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const DEDUP_TTL_MS = 10 * 60 * 1000;

const FETCH_TICKET_PY = path.join(__dirname, "fetch_ticket.py");
const BUILD_PROMPT_PY = path.join(__dirname, "build_prompt.py");
const LINEAR_UPDATE_PY = path.join(__dirname, "linear_update.py");
// create_pr.py lives in each worktree (from the branch), not a fixed path
const CREATE_PR_PY_NAME = "create_pr.py";

process.env.PATH = `${path.join(__dirname, "bin")}:${path.dirname(FLUTTER_BIN)}:${process.env.PATH}`;

// --- Two Slack apps ---
const pmApp = new App({
  token: process.env.PM_SLACK_BOT_TOKEN,
  appToken: process.env.PM_SLACK_APP_TOKEN,
  socketMode: true,
});

const devApp = new App({
  token: process.env.DEV_SLACK_BOT_TOKEN,
  appToken: process.env.DEV_SLACK_APP_TOKEN,
  socketMode: true,
});

if (!process.env.PM_SLACK_BOT_TOKEN) throw new Error("PM_SLACK_BOT_TOKEN is required");
if (!process.env.PM_SLACK_APP_TOKEN) throw new Error("PM_SLACK_APP_TOKEN is required");
if (!process.env.DEV_SLACK_BOT_TOKEN) throw new Error("DEV_SLACK_BOT_TOKEN is required");
if (!process.env.DEV_SLACK_APP_TOKEN) throw new Error("DEV_SLACK_APP_TOKEN is required");

// --- Shared state ---
const queue = new PQueue({ concurrency: 1 });
const recentTickets = new Map();
const pendingApprovals = new Map();

// --- Helpers ---
async function postThread(client, channelId, threadTs, text) {
  try {
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
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
    throw new Error(`Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}\n${stderr || stdout}`);
  }
  return result.stdout || "";
}

function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
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
      } else { resolve(stdout); }
    });
    if (opts.timeout) {
      setTimeout(() => { proc.kill(); reject(new Error(`Command timed out: ${cmd}`)); }, opts.timeout);
    }
  });
}

function getLatestSessionId() {
  const sessionsDir = path.join(process.env.HOME, ".claude", "sessions");
  try {
    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith(".json"))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.name.replace(".json", "") || null;
  } catch { return null; }
}

function cleanupWorktree(worktreePath) {
  try {
    spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
      encoding: "utf8", stdio: "ignore", cwd: REPO_ROOT,
    });
  } catch (_) {}
}

function isRecentlyQueued(ticketId) {
  const ts = recentTickets.get(ticketId);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) { recentTickets.delete(ticketId); return false; }
  return true;
}

function waitForApproval(threadTs, timeoutMs = 60 * 60 * 1000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(threadTs);
      resolve({ approved: false, extra: "" });
    }, timeoutMs);
    pendingApprovals.set(threadTs, { resolve: (val) => { clearTimeout(timer); resolve(val); } });
  });
}

// Fetch all messages in a Slack thread to use as context
async function fetchThreadContext(client, channelId, threadTs) {
  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 100,
    });
    const messages = (result.messages || [])
      .map(m => m.text)
      .filter(Boolean);
    return messages.join("\n\n");
  } catch (err) {
    console.error("Failed to fetch thread context:", err.message);
    return "";
  }
}

// --- Shared worktree helper: create-or-reuse ---
function ensureWorktree(ticketId) {
  const branch = `feat/${ticketId.toLowerCase()}`;
  const worktreePath = path.join(WORKTREE_BASE, ticketId);
  fs.mkdirSync(WORKTREE_BASE, { recursive: true });
  run("git", ["fetch", "origin"], { cwd: REPO_ROOT });
  spawnSync("git", ["worktree", "prune"], { cwd: REPO_ROOT, encoding: "utf8" });

  if (fs.existsSync(worktreePath)) {
    // Worktree exists — check if it's on the correct branch
    const head = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, encoding: "utf8" });
    const currentBranch = (head.stdout || "").trim();
    if (currentBranch === branch) {
      return { worktreePath, branch, created: false };
    }
    // Wrong branch or detached HEAD — remove and recreate
    spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: REPO_ROOT, encoding: "utf8" });
  }

  // Check if branch exists on remote
  const remoteCheck = spawnSync("git", ["ls-remote", "--heads", "origin", branch], { cwd: REPO_ROOT, encoding: "utf8" });
  const remoteExists = (remoteCheck.stdout || "").trim().length > 0;

  // Delete local branch if it exists (might be stale)
  spawnSync("git", ["branch", "-D", branch], { cwd: REPO_ROOT, encoding: "utf8" });

  if (remoteExists) {
    // Remote branch exists (PM already pushed) — track it to preserve artifacts
    run("git", ["worktree", "add", "-b", branch, worktreePath, `origin/${branch}`], { cwd: REPO_ROOT });
  } else {
    // Fresh start from trunk
    run("git", ["worktree", "add", "-b", branch, worktreePath, "origin/trunk"], { cwd: REPO_ROOT });
  }

  return { worktreePath, branch, created: true };
}

// ===================================================================
// PM Agent — "prd CAF-123"
// ===================================================================
pmApp.message(/^prd\s+([A-Z]+-\d+)$/i, async ({ message, client }) => {
  const ticketId = message.text.replace(/^prd\s+/i, "").trim().toUpperCase();
  const channelId = message.channel;
  const threadTs = message.ts;
  const requesterId = message.user;
  try { await client.reactions.add({ channel: channelId, timestamp: threadTs, name: "memo" }); } catch (_) {}
  await postThread(client, channelId, threadTs, `Generating PRD + OpenSpec artifacts for \`${ticketId}\`...`);

  queue.add(async () => {
    let worktreePath, branch;
    try {
      // Fetch ticket
      run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });

      // Create or reuse worktree with feature branch
      ({ worktreePath, branch } = ensureWorktree(ticketId));

      // Run /opsx:ff which creates openspec artifacts (proposal, design, specs, tasks)
      await postThread(client, channelId, threadTs, `PM agent is working on \`${branch}\` (PRD + specs + tasks)...`);
      run("python3", [BUILD_PROMPT_PY, ticketId, worktreePath, "prd"], { env: { ...process.env } });
      const prdPrompt = fs.readFileSync(`/tmp/agent-prompt-${ticketId}-prd.txt`, "utf8");
      await runAsync(
        CLAUDE_BIN, ["--print", "--dangerously-skip-permissions", "--name", `${ticketId}-prd`],
        { input: prdPrompt, cwd: worktreePath, env: { ...process.env, GIT_WORK_TREE: worktreePath }, timeout: CLAUDE_TIMEOUT_MS }
      );

      // Ensure artifacts are committed and pushed (safety net)
      spawnSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf8" });
      spawnSync("git", ["commit", "-m", `chore: add openspec artifacts for ${ticketId}`], { cwd: worktreePath, encoding: "utf8" });
      run("git", ["push", "-u", "origin", branch], { cwd: worktreePath });

      // Read generated artifacts and post to Slack
      const changesDir = path.join(worktreePath, "openspec", "changes");
      if (fs.existsSync(changesDir)) {
        const changeDirs = fs.readdirSync(changesDir)
          .filter(d => d !== "archive" && fs.statSync(path.join(changesDir, d)).isDirectory());

        for (const dir of changeDirs) {
          const artifactDir = path.join(changesDir, dir);
          const files = fs.readdirSync(artifactDir).filter(f => f.endsWith(".md"));
          await postThread(client, channelId, threadTs, `*OpenSpec: \`${dir}\`*`);
          for (const file of files) {
            const content = fs.readFileSync(path.join(artifactDir, file), "utf8").trim();
            const header = `📄 *${file}*`;
            // Post in chunks
            for (let i = 0; i < content.length; i += 3000) {
              const chunk = i === 0 ? `${header}\n\`\`\`\n${content.slice(i, i + 3000)}\n\`\`\`` : `\`\`\`\n${content.slice(i, i + 3000)}\n\`\`\``;
              await postThread(client, channelId, threadTs, chunk);
            }
          }
        }
      }

      // Mention requester
      await postThread(client, channelId, threadTs,
        `<@${requesterId}> PRD + specs for \`${ticketId}\` ready!\n\n` +
        `*Artifacts saved to:* \`${path.join("openspec", "changes")}\`\n\n` +
        `*Next steps:*\n` +
        `• Leave feedback + \`update\` — PM Bot revises the specs\n` +
        `• \`dev ${ticketId}\` — Dev Agent starts implementation (skips artifact generation)\n` +
        `• \`approve: <extra notes>\` after dev starts to add instructions`
      );

      const sessionId = getLatestSessionId();
      if (sessionId) {
        await postThread(client, channelId, threadTs,
          `To continue locally:\n\`\`\`\ncd ${worktreePath}\nclaude --resume ${ticketId}-prd\n\`\`\``
        );
      }
    } catch (err) {
      console.error(`[PRD ${ticketId}] failed:`, err.message);
      await postThread(client, channelId, threadTs, `PRD generation failed: ${err.message}`);
    }
  });
});

// --- PM thread revision: "update" in a prd thread ---
pmApp.message(/^update$/i, async ({ message, client }) => {
  if (!message.thread_ts) return;
  const channelId = message.channel;
  const threadTs = message.thread_ts;

  // Find the ticket ID from the parent thread
  const threadContext = await fetchThreadContext(client, channelId, threadTs);
  const ticketMatch = threadContext.match(/([A-Z]+-\d+)/);
  if (!ticketMatch) {
    await postThread(client, channelId, threadTs, "Couldn't find a ticket ID in this thread.");
    return;
  }
  const ticketId = ticketMatch[1].toUpperCase();

  try { await client.reactions.add({ channel: channelId, timestamp: message.ts, name: "pencil2" }); } catch (_) {}
  await postThread(client, channelId, threadTs, `Revising PRD for \`${ticketId}\` based on feedback...`);

  queue.add(async () => {
    try {
      const fullThread = await fetchThreadContext(client, channelId, threadTs);

      // Ensure worktree exists (reuse if PM already created it)
      const { worktreePath, branch } = ensureWorktree(ticketId);
      const workDir = worktreePath;

      run("python3", [BUILD_PROMPT_PY, ticketId, workDir, "revise", fullThread], { env: { ...process.env } });
      const revisePrompt = fs.readFileSync(`/tmp/agent-prompt-${ticketId}-revise.txt`, "utf8");

      await runAsync(
        CLAUDE_BIN, ["--print", "--dangerously-skip-permissions", "--name", `${ticketId}-revise`],
        { input: revisePrompt, cwd: workDir, env: { ...process.env, GIT_WORK_TREE: workDir }, timeout: CLAUDE_TIMEOUT_MS }
      );

      // Read updated artifacts and post to Slack
      const changesDir = path.join(workDir, "openspec", "changes");
      if (fs.existsSync(changesDir)) {
        const changeDirs = fs.readdirSync(changesDir)
          .filter(d => d !== "archive" && fs.statSync(path.join(changesDir, d)).isDirectory());
        for (const dir of changeDirs) {
          const artifactDir = path.join(changesDir, dir);
          const files = fs.readdirSync(artifactDir).filter(f => f.endsWith(".md"));
          await postThread(client, channelId, threadTs, `*Revised OpenSpec: \`${dir}\`*`);
          for (const file of files) {
            const content = fs.readFileSync(path.join(artifactDir, file), "utf8").trim();
            for (let i = 0; i < content.length; i += 3000) {
              const chunk = i === 0 ? `📄 *${file}*\n\`\`\`\n${content.slice(i, i + 3000)}\n\`\`\`` : `\`\`\`\n${content.slice(i, i + 3000)}\n\`\`\``;
              await postThread(client, channelId, threadTs, chunk);
            }
          }
        }
      }

      // Commit and push revised artifacts
      spawnSync("git", ["add", "-A"], { cwd: workDir, encoding: "utf8" });
      spawnSync("git", ["commit", "-m", `chore: revise openspec artifacts for ${ticketId}`], { cwd: workDir, encoding: "utf8" });
      spawnSync("git", ["push", "origin", branch], { cwd: workDir, encoding: "utf8" });

      await postThread(client, channelId, threadTs,
        `Specs revised and pushed to \`${branch}\`!\n` +
        `• More feedback + \`update\` to revise again\n` +
        `• \`dev ${ticketId}\` to start implementation`
      );
    } catch (err) {
      console.error(`[PRD revise ${ticketId}] failed:`, err.message);
      await postThread(client, channelId, threadTs, `Revision failed: ${err.message}`);
    }
  });
});

// ===================================================================
// Dev Agent
// ===================================================================

// --- Approval handler ---
devApp.message(async ({ message, next }) => {
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

// --- "dev CAF-123" in a thread (inherits PM context) or "CAF-123" top-level ---
devApp.message(/^(?:dev\s+)?([A-Z]+-\d+)$/i, async ({ message, client }) => {
  const match = message.text.match(/^(?:dev\s+)?([A-Z]+-\d+)$/i);
  if (!match) return;
  const ticketId = match[1].toUpperCase();
  const channelId = message.channel;
  // If posted in a thread, use parent thread ts; otherwise use message ts
  const threadTs = message.thread_ts || message.ts;
  const isFromThread = !!message.thread_ts;

  try { await client.reactions.add({ channel: channelId, timestamp: message.ts, name: "eyes" }); } catch (_) {}

  if (isRecentlyQueued(ticketId)) {
    await postThread(client, channelId, threadTs, `Already working on \`${ticketId}\`. Check the thread above.`);
    return;
  }

  recentTickets.set(ticketId, Date.now());

  // Fetch thread context if triggered from an existing thread (e.g., PM thread)
  let threadContext = "";
  if (isFromThread) {
    threadContext = await fetchThreadContext(client, channelId, threadTs);
    await postThread(client, channelId, threadTs,
      `Queued \`${ticketId}\` — incorporating thread context into development.`
    );
  } else {
    await postThread(client, channelId, threadTs,
      `Queued \`${ticketId}\` — I'll update this thread as I go.`
    );
  }

  queue.add(() => runDevJob(ticketId, channelId, threadTs, client, threadContext));
});

// --- Main dev job runner ---
async function runDevJob(ticketId, channelId, threadTs, client, threadContext) {
  let jobTimedOut = false;
  const jobTimer = setTimeout(() => { jobTimedOut = true; }, JOB_TIMEOUT_MS);

  let worktreePath, branch;

  try {
    // Step 1: Fetch ticket + Linear update
    await postThread(client, channelId, threadTs, `Fetching ticket \`${ticketId}\`...`);
    run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });
    run("python3", [LINEAR_UPDATE_PY, ticketId], { env: { ...process.env } });

    if (jobTimedOut) throw new Error("Job timed out");

    // Step 2: Create or reuse worktree with feature branch
    await postThread(client, channelId, threadTs, `Preparing workspace...`);
    ({ worktreePath, branch } = ensureWorktree(ticketId));

    if (jobTimedOut) throw new Error("Job timed out");

    // Step 3: Check if openspec artifacts already exist (e.g., from PM agent)
    const changesDir = path.join(worktreePath, "openspec", "changes");
    const hasArtifacts = fs.existsSync(changesDir) && fs.readdirSync(changesDir)
      .filter(d => d !== "archive" && fs.statSync(path.join(changesDir, d)).isDirectory()).length > 0;

    if (hasArtifacts) {
      const existing = fs.readdirSync(changesDir).filter(d => d !== "archive" && fs.statSync(path.join(changesDir, d)).isDirectory());
      await postThread(client, channelId, threadTs,
        `OpenSpec artifacts already exist: \`${existing.join("`, `")}\`\n` +
        `Skipping artifact generation.\nReply \`approve\` to start implementation, or \`reject\` to cancel.\nYou can also reply \`approve: <extra instructions>\`.`
      );
    } else {
      await postThread(client, channelId, threadTs, `Generating artifacts (QA + Dev)...`);
      run("python3", [BUILD_PROMPT_PY, ticketId, worktreePath, "ff"], { env: { ...process.env } });
      let ffPrompt = fs.readFileSync(`/tmp/agent-prompt-${ticketId}-ff.txt`, "utf8");

      if (threadContext) {
        ffPrompt += `\n\n## Prior discussion and PRD from Slack thread\n\nThe following messages were posted in the Slack thread before this dev job started. Use them as context — they may contain a PRD, design feedback, or specific instructions from the reviewer.\n\n${threadContext}\n`;
      }

      const ffOutput = await runAsync(
        CLAUDE_BIN, ["--print", "--dangerously-skip-permissions", "--model", "opus", "--name", `${ticketId}-ff`],
        { input: ffPrompt, cwd: worktreePath, env: { ...process.env, GIT_WORK_TREE: worktreePath }, timeout: CLAUDE_TIMEOUT_MS }
      );

      if (jobTimedOut) throw new Error("Job timed out");

      const ffSummary = ffOutput.trim().slice(-1500) || "(no output)";
      await postThread(client, channelId, threadTs,
        `Artifacts ready:\n\`\`\`\n${ffSummary}\n\`\`\`\nReply \`approve\` to start implementation, or \`reject\` to cancel.\nYou can also reply \`approve: <extra instructions>\`.`
      );
    }

    const { approved, extra } = await waitForApproval(threadTs);
    if (!approved) {
      await postThread(client, channelId, threadTs, `Cancelled \`${ticketId}\`.`);
      return;
    }

    // Branch already exists from ensureWorktree — verify
    const currentBranch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath }).trim();
    await postThread(client, channelId, threadTs, `Working on branch \`${currentBranch}\`...`);

    // Skill runner with retry
    const runSkill = async (label, prompt, retries = 2) => {
      await postThread(client, channelId, threadTs, `Running \`${label}\`...`);
      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
          const out = await runAsync(
            CLAUDE_BIN, ["--print", "--dangerously-skip-permissions", "--model", "opus", "--name", `${ticketId}-${label}`],
            { input: prompt, cwd: worktreePath, env: { ...process.env, GIT_WORK_TREE: worktreePath }, timeout: CLAUDE_TIMEOUT_MS }
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

    // Build apply prompt with thread context + extra instructions
    let applyExtra = extra;
    if (threadContext && !applyExtra) {
      applyExtra = `The following Slack thread context may contain relevant feedback:\n${threadContext}`;
    } else if (threadContext && applyExtra) {
      applyExtra = `${applyExtra}\n\nSlack thread context:\n${threadContext}`;
    }

    // Step 4b: /opsx:apply
    run("python3", [BUILD_PROMPT_PY, ticketId, worktreePath, "apply", applyExtra], { env: { ...process.env } });
    const applyPrompt = fs.readFileSync(`/tmp/agent-prompt-${ticketId}-apply.txt`, "utf8");
    await runSkill("opsx:apply", applyPrompt);

    // Step 5: /commit
    await runSkill("commit", `/commit\n\nDo not ask for confirmation. Commit all changes automatically.\nIMPORTANT: You are working in a git worktree at ${worktreePath} on branch ${branch}. All git commands must run inside this directory. Do NOT commit to any other branch or directory.`);

    // Step 6: /format
    await runSkill("format", `/format\n\nDo not ask for confirmation. Format and commit automatically.\nIMPORTANT: You are working in a git worktree at ${worktreePath} on branch ${branch}. All git commands must run inside this directory.`);

    // Step 7: push all commits + create PR
    await postThread(client, channelId, threadTs, `Pushing and creating PR...`);
    run("git", ["push", "origin", "HEAD", "--force-with-lease"], { cwd: worktreePath });
    run("python3", [path.join(worktreePath, CREATE_PR_PY_NAME)], { cwd: worktreePath, env: { ...process.env, TICKET_ID: ticketId } });
    if (jobTimedOut) throw new Error("Job timed out");

    const prUrlFile = `/tmp/pr-url-${ticketId}.txt`;
    let prUrl = "";
    if (fs.existsSync(prUrlFile)) { prUrl = fs.readFileSync(prUrlFile, "utf8").trim(); }

    // Step 8: /code-review
    const reviewOut = await runSkill("code-review", `/code-review\n\nAfter generating the review, automatically post it as a comment on the PR. Do not ask for confirmation.\nIMPORTANT: You are working in a git worktree at ${worktreePath} on branch ${branch}.`);
    const reviewTruncated = reviewOut.trim().slice(-2000) || "(no output)";
    await postThread(client, channelId, threadTs, `Code review:\n\`\`\`\n${reviewTruncated}\n\`\`\``);

    const successMsg = prUrl
      ? `All done! PR ready: ${prUrl}`
      : `All done! \`${ticketId}\` implementation complete.`;
    await postThread(client, channelId, threadTs, successMsg);

    const sessionId = getLatestSessionId();
    if (sessionId) {
      await postThread(client, channelId, threadTs,
        `To continue in terminal:\n\`\`\`\ncd ${worktreePath}\nclaude --resume ${ticketId}\n\`\`\`\nAll sessions: \`${ticketId}-ff\`, \`${ticketId}-opsx:apply\`, \`${ticketId}-commit\`, \`${ticketId}-format\`, \`${ticketId}-code-review\``
      );
    }
  } catch (err) {
    console.error(`[${ticketId}] Job failed:`, err.message);
    await postThread(client, channelId, threadTs, `Failed on \`${ticketId}\`: ${err.message}\nWorktree preserved at \`${worktreePath}\` for debugging.`);
  } finally {
    clearTimeout(jobTimer);
    recentTickets.delete(ticketId);
  }
}

// --- Start both bots ---
(async () => {
  await Promise.all([pmApp.start(), devApp.start()]);
  console.log("PM agent + Dev agent running (Socket Mode)");
})();
