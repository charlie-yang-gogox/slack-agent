"use strict";

require("dotenv").config();

const { App } = require("@slack/bolt");
const PQueue = require("p-queue").default;
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { agentEvents, registerStatusProvider } = require("./events");

// --- Constants (from env or defaults) ---
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const FLUTTER_BIN = process.env.FLUTTER_BIN || "flutter";
const REPO_ROOT = process.env.REPO_ROOT;
if (!REPO_ROOT) throw new Error("REPO_ROOT is required (path to your flutter project)");
const WORKTREE_BASE = process.env.WORKTREE_BASE || path.join(REPO_ROOT, ".claude", "worktree");
const CLAUDE_TIMEOUT_MS = 45 * 60 * 1000;
const JOB_TIMEOUT_MS = 60 * 60 * 1000;
const DEDUP_TTL_MS = 10 * 60 * 1000;

// Read original project path from target repo's port-settings.json (set by /port skill)
const PORT_SETTINGS_PATH = path.join(REPO_ROOT, ".claude", "port-settings.json");
const ORIGINAL_PROJECT_PATH = (() => {
  try { return JSON.parse(fs.readFileSync(PORT_SETTINGS_PATH, "utf8")).originalProjectPath || ""; }
  catch { return ""; }
})();

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
  clientOptions: { slackApiUrl: "https://slack.com/api/" },
  socketModeOptions: { clientPingTimeout: 30000, serverPingTimeout: 30000 },
});

const devApp = new App({
  token: process.env.DEV_SLACK_BOT_TOKEN,
  appToken: process.env.DEV_SLACK_APP_TOKEN,
  socketMode: true,
  clientOptions: { slackApiUrl: "https://slack.com/api/" },
  socketModeOptions: { clientPingTimeout: 30000, serverPingTimeout: 30000 },
});

if (!process.env.PM_SLACK_BOT_TOKEN) throw new Error("PM_SLACK_BOT_TOKEN is required");
if (!process.env.PM_SLACK_APP_TOKEN) throw new Error("PM_SLACK_APP_TOKEN is required");
if (!process.env.DEV_SLACK_BOT_TOKEN) throw new Error("DEV_SLACK_BOT_TOKEN is required");
if (!process.env.DEV_SLACK_APP_TOKEN) throw new Error("DEV_SLACK_APP_TOKEN is required");

// --- Bot user IDs (resolved at startup) ---
let pmBotUserId, devBotUserId;
const startupTs = Date.now() / 1000; // Unix timestamp in seconds, for ignoring stale events

// --- Shared state ---
const queue = new PQueue({ concurrency: 1 });
const recentTickets = new Map();
const pendingApprovals = new Map();
const activeProcesses = new Map(); // ticketId → { proc, threadTs, channelId }
const cancelledTickets = new Set(); // ticketIds that were cancelled (to suppress error messages)
const pendingConfirmations = new Map(); // threadTs → { resolve }
const ffTickets = new Set(); // ticketIds currently in ff mode → skip approve + worktree confirm in dev
const ffTicketExtras = new Map(); // ticketId → extra instructions string

// --- Status provider for web dashboard ---
registerStatusProvider(() => {
  const active = activeProcesses.size > 0 ? Array.from(activeProcesses.entries()).map(([id, info]) => ({
    ticketId: id,
    threadTs: info.threadTs,
    channelId: info.channelId,
  })) : [];
  return {
    activeJobs: active,
    queueSize: queue.size + queue.pending,
    pendingApprovals: Array.from(new Set([...pendingApprovals.keys(), ...ticketApprovals.keys()])),
    ffTickets: Array.from(ffTickets),
    uptime: process.uptime(),
  };
});

// --- Ticket-based approval map (for web UI — parallel to threadTs-based pendingApprovals) ---
const ticketApprovals = new Map(); // ticketId → { resolve }

// --- Shim Slack client for web-triggered jobs (no-op posting) ---
const webClient = {
  chat: { postMessage: async () => {} },
  reactions: { add: async () => {} },
  conversations: { replies: async () => ({ messages: [] }) },
};

// --- Cleanup helper (centralizes state cleanup for a ticket) ---
function cleanupTicket(ticketId) {
  recentTickets.delete(ticketId);
  cancelledTickets.delete(ticketId);
  ffTickets.delete(ticketId);
  ffTicketExtras.delete(ticketId);
  ticketApprovals.delete(ticketId);
}

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
    let lineBuf = ""; // dual buffer for line-based event emission
    if (opts.input) proc.stdin.end(opts.input);
    proc.stdout.on("data", (d) => {
      stdout += d;
      process.stdout.write(d);
      // Line-based emission for dashboard
      if (opts.ticketId) {
        lineBuf += d;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop(); // keep incomplete last line in buffer
        for (const line of lines) {
          if (line.trim()) {
            agentEvents.emit("job:log", { ticketId: opts.ticketId, source: "stdout", message: line, ts: new Date().toISOString() });
          }
        }
      }
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
      if (opts.ticketId && d.toString().trim()) {
        agentEvents.emit("job:log", { ticketId: opts.ticketId, source: "stderr", message: d.toString().trim(), level: "warn", ts: new Date().toISOString() });
      }
    });
    proc.on("error", (err) => {
      if (opts.ticketId) activeProcesses.delete(opts.ticketId);
      reject(err);
    });
    proc.on("close", (code) => {
      // Flush remaining line buffer
      if (opts.ticketId && lineBuf.trim()) {
        agentEvents.emit("job:log", { ticketId: opts.ticketId, source: "stdout", message: lineBuf.trim(), ts: new Date().toISOString() });
        lineBuf = "";
      }
      if (opts.ticketId) activeProcesses.delete(opts.ticketId);
      if (code !== 0) {
        reject(new Error(`Command failed (exit ${code}): ${cmd} ${args.join(" ")}\n${(stderr || stdout).trim()}`));
      } else { resolve(stdout); }
    });
    // Heartbeat log every 2 minutes while process is running
    const heartbeat = opts.ticketId ? setInterval(() => {
      const elapsed = Math.round((Date.now() - heartbeatStart) / 1000);
      console.log(`[${opts.ticketId}] still running... (${elapsed}s elapsed)`);
    }, 2 * 60 * 1000) : null;
    const heartbeatStart = Date.now();
    proc.on("close", () => { if (heartbeat) clearInterval(heartbeat); });
    if (opts.ticketId) {
      activeProcesses.set(opts.ticketId, { proc, threadTs: opts.threadTs, channelId: opts.channelId });
    }
    if (opts.timeout) {
      setTimeout(() => { proc.kill(); reject(new Error(`Command timed out: ${cmd}`)); }, opts.timeout);
    }
  });
}

function stripMention(text) {
  return (text || "").replace(/^\s*<@[A-Z0-9]+>\s*/i, "").trim();
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

// Clean agent output — strip permission error lines, keep real content
function cleanAgentOutput(content) {
  if (!content) return "";
  const lines = content.split("\n");
  const failurePatterns = [
    "could you approve",
    "seems to be restricted",
    "asking for permission",
    "i don't have access",
    "i cannot write",
    "unable to write",
    "please approve",
    "directory is protected",
    "requires permission",
  ];
  const cleaned = lines.filter(line => {
    const lower = line.toLowerCase();
    return !failurePatterns.some(p => lower.includes(p));
  }).join("\n").trim();
  return cleaned;
}

function validateAgentOutput(content) {
  const cleaned = cleanAgentOutput(content);
  return cleaned.length >= 50;
}

function safetyCommit(worktreePath, ticketId, label) {
  spawnSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf8" });
  const dirty = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: worktreePath, encoding: "utf8" }).status !== 0;
  if (dirty) {
    console.log(`[${ticketId}] Safety net (${label}): committing uncommitted changes`);
    spawnSync("git", ["commit", "-m", `feat(${ticketId}): safety commit ${label}`], { cwd: worktreePath, encoding: "utf8" });
  }
}

function buildTicketContext(ticketId, worktreePath, extraInstructions = "") {
  const ticketPath = `/tmp/ticket-${ticketId}.json`;
  const ticket = JSON.parse(fs.readFileSync(ticketPath, "utf8"));
  const branch = `feat/${ticketId}`;
  let context = `Ticket: ${ticketId} — ${ticket.title}\n`;
  if (ticket.description) context += `\nDescription:\n${ticket.description}\n`;
  context += `\nBranch: ${branch}\nWorktree: ${worktreePath}\n`;
  if (extraInstructions) context += `\n## Additional instructions\n${extraInstructions}\n`;
  return context;
}

// Check if openspec artifacts truly exist (dir with proposal.md = real artifacts from /opsx:ff)
function checkArtifacts(changesDir) {
  if (!fs.existsSync(changesDir)) return { hasArtifacts: false, dirs: [] };
  const dirs = fs.readdirSync(changesDir)
    .filter(d => d !== "archive" && d !== ".gitkeep" && fs.statSync(path.join(changesDir, d)).isDirectory())
    .filter(d => fs.existsSync(path.join(changesDir, d, "proposal.md")));
  return { hasArtifacts: dirs.length > 0, dirs };
}

async function postArtifactsToSlack(changesDir, client, channelId, threadTs) {
  const { dirs } = checkArtifacts(changesDir);
  for (const dir of dirs) {
    const artifactDir = path.join(changesDir, dir);
    const files = fs.readdirSync(artifactDir).filter(f => f.endsWith(".md"));
    await postThread(client, channelId, threadTs, `*OpenSpec: \`${dir}\`*`);
    for (const file of files) {
      const content = fs.readFileSync(path.join(artifactDir, file), "utf8").trim();
      const header = `📄 *${file}*`;
      for (let i = 0; i < content.length; i += 3000) {
        const chunk = i === 0 ? `${header}\n\`\`\`\n${content.slice(i, i + 3000)}\n\`\`\`` : `\`\`\`\n${content.slice(i, i + 3000)}\n\`\`\``;
        await postThread(client, channelId, threadTs, chunk);
      }
    }
  }
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/[\s]+/g, "-").trim();
}

// --- Port: Explore original project ---
async function runExplore(ticketId, worktreePath) {
  const ticketPath = `/tmp/ticket-${ticketId}.json`;
  const ticket = JSON.parse(fs.readFileSync(ticketPath, "utf8"));

  const explorePrompt = `You are scanning an original project to document a specific feature for porting.

Original project path: ${ORIGINAL_PROJECT_PATH}
Feature to find: ${ticket.title}

Ticket context:
${ticket.description || "(no description)"}

Explore the codebase thoroughly and produce a structured markdown report. Keep the report HIGH-LEVEL — focus on WHAT the feature does and its rules, NOT how the original project implements it internally.

## Feature Overview
Brief summary of what the feature does from a user perspective. 2-3 sentences max.

## User-Facing Behavior
Describe the feature from the user's perspective: what they see, what they interact with, what happens on success/failure. Use plain language, not code references.

## Business Rules
Numbered list of every rule, validation, and edge case. Be exhaustive. These rules should be implementation-agnostic — describe WHAT must be true, not HOW the original code achieves it.

## Data Models
Key data structures with field names and types. Include class/model/enum definitions as reference material. Only include models directly relevant to this feature.

## API / Service Contracts
API endpoints, request/response shapes, status codes, and error conditions. This is critical for the port — be precise.

## UI States & Flows
High-level description of screens involved, navigation flow between them, and key UI states (loading, error, empty, success). Do NOT list original project file paths or widget class names — describe what the user sees.

IMPORTANT:
- Do NOT list original project file paths, class names, or architecture patterns
- Do NOT describe state management implementation details
- Do NOT include raw business logic code — describe the rules in plain language instead
- Code is ONLY allowed for: data model definitions, API request/response shapes
- Focus on WHAT and WHY, never HOW the original implements it`;

  const output = await runAsync(
    CLAUDE_BIN, ["--print", "--dangerously-skip-permissions", "--name", `${ticketId}-explore`],
    { input: explorePrompt, cwd: ORIGINAL_PROJECT_PATH, env: { ...process.env }, timeout: CLAUDE_TIMEOUT_MS, ticketId }
  );

  const cleaned = cleanAgentOutput(output.trim());
  if (!cleaned || cleaned.length < 50) {
    throw new Error("Explore agent produced insufficient output");
  }

  // Cache to worktree for retry resilience + port detection
  const cachePath = path.join(worktreePath, "openspec", "changes");
  fs.mkdirSync(cachePath, { recursive: true });
  const cacheFile = path.join(cachePath, "port-source-analysis.md");
  fs.writeFileSync(cacheFile, cleaned, "utf8");

  return cleaned;
}

// --- Port: Post artifacts to Linear via Claude CLI (delegates to target repo's MCP tools) ---
async function postPortArtifactsToLinear(ticketId, worktreePath) {
  const changesDir = path.join(worktreePath, "openspec", "changes");
  const saPath = path.join(changesDir, "port-source-analysis.md");
  const ticketPath = `/tmp/ticket-${ticketId}.json`;
  if (!fs.existsSync(ticketPath)) {
    console.error(`[${ticketId}] Ticket JSON not found, skipping Linear post`);
    return;
  }
  const ticket = JSON.parse(fs.readFileSync(ticketPath, "utf8"));
  const titleSlug = slugify(ticket.title);
  const artifactDir = path.join(changesDir, titleSlug);
  const prdPath = path.join(artifactDir, "prd.md");
  const designPath = path.join(artifactDir, "design-guidance.md");

  // Collect artifact contents
  const sa = fs.existsSync(saPath) ? fs.readFileSync(saPath, "utf8").trim() : "";
  const prd = fs.existsSync(prdPath) ? fs.readFileSync(prdPath, "utf8").trim() : "";
  const design = fs.existsSync(designPath) ? fs.readFileSync(designPath, "utf8").trim() : null;

  if (!sa && !prd) {
    console.log(`[${ticketId}] No artifacts to post to Linear`);
    return;
  }

  // Compose the comment body (same HTML marker format the target repo's port-feature skill expects)
  let body = `## Port Source Analysis\n<!-- PORT:SOURCE_ANALYSIS:START -->\n${sa}\n<!-- PORT:SOURCE_ANALYSIS:END -->\n\n---\n\n`;
  body += `## Port PRD\n<!-- PORT:PRD:START -->\n${prd}\n<!-- PORT:PRD:END -->\n`;
  if (design) {
    body += `\n---\n\n## Port Design Changed\n<!-- PORT:DESIGN_CHANGED:START -->\n${design}\n<!-- PORT:DESIGN_CHANGED:END -->\n`;
  }
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  body += `\n---\n\n_Posted: ${now} by Slack PM Agent_`;

  const prompt = `Post the following as a comment on Linear ticket ${ticketId} (identifier: "${ticketId}").
Use the Linear MCP tool (save_comment or equivalent) to create or update the comment.
Do NOT modify the content — post it exactly as provided.

---
${body}`;

  try {
    await runAsync(
      CLAUDE_BIN, ["--print", "--dangerously-skip-permissions", "--name", `${ticketId}-linear-post`],
      { input: prompt, cwd: worktreePath, env: { ...process.env }, timeout: 5 * 60 * 1000, ticketId }
    );
    console.log(`[${ticketId}] Port artifacts posted to Linear via Claude CLI`);
  } catch (err) {
    console.error(`[${ticketId}] Failed to post to Linear via Claude CLI:`, err.message);
  }
}

// Three-step PM phase: pm-agent + designer-agent (parallel, cached) → orchestrator /opsx:ff
// Cache is managed by agent.js, not by Claude
async function runPMPhase(ticketId, worktreePath, channelId, threadTs, opts = {}) {
  const { sourceAnalysis = null } = opts;
  const ticketContext = buildTicketContext(ticketId, worktreePath);
  const ticketPath = `/tmp/ticket-${ticketId}.json`;
  const ticket = JSON.parse(fs.readFileSync(ticketPath, "utf8"));
  const titleSlug = slugify(ticket.title);
  const cacheDir = path.join(worktreePath, "openspec", "changes", titleSlug);
  const prdCache = path.join(cacheDir, "prd.md");
  const designCache = path.join(cacheDir, "design-guidance.md");

  fs.mkdirSync(cacheDir, { recursive: true });

  // Step 1: Run pm-agent + designer-agent (skip if valid cache exists)
  // Read agent definitions from target repo and inline as prompt context (no --agent flag).
  // These agents only produce text — no tools needed, avoids permission issues.
  const readAgentDef = (agentName) => {
    const agentPath = path.join(REPO_ROOT, ".claude", "agents", `${agentName}.md`);
    if (!fs.existsSync(agentPath)) {
      console.warn(`[${ticketId}] Agent definition not found: ${agentPath}, using agentName as fallback`);
      return `You are a ${agentName}. Produce your output as markdown.`;
    }
    return fs.readFileSync(agentPath, "utf8").trim();
  };

  const runAndValidate = async (agentName, cachePath, sessionSuffix) => {
    const agentDef = readAgentDef(agentName);
    let prompt = `${agentDef}\n\n---\n\n${ticketContext}`;
    if (sourceAnalysis && agentName === "pm-agent") {
      prompt += `\n\n## Source Analysis (from original project)\n\n${sourceAnalysis}\n\nThis is a PORT — adapt requirements from the original project. Do NOT include source code (except data model definitions). Only describe requirements and approach.`;
    }
    if (sourceAnalysis && agentName === "designer-agent") {
      prompt += `\n\n## Source Analysis (from original project)\n\n${sourceAnalysis}\n\nThis is a PORT — identify UI/design changes needed when porting this feature.`;
    }
    prompt += `\n\nOutput your full result as markdown to stdout. Do NOT use the Write tool or attempt to write files.`;
    const output = await runAsync(
      CLAUDE_BIN, ["--print", "--dangerously-skip-permissions", "--model", "sonnet", "--name", `${ticketId}-${sessionSuffix}`],
      { input: prompt,
        cwd: worktreePath, env: { ...process.env, GIT_WORK_TREE: worktreePath }, timeout: CLAUDE_TIMEOUT_MS, ticketId, threadTs, channelId }
    );
    // Capture stdout and write to cache ourselves
    const content = cleanAgentOutput(output.trim());
    console.log(`[${ticketId}] ${agentName}: stdout=${output.trim().length}chars, cleaned=${content.length}chars`);
    if (!content || content.length < 10) {
      console.error(`[${ticketId}] ${agentName} output failed validation (empty after cleaning)`);
      return false;
    }
    fs.writeFileSync(cachePath, content, "utf8");
    console.log(`[${ticketId}] ${agentName} done → ${cachePath}`);
    return true;
  };

  const isCacheValid = (cachePath) => {
    if (!fs.existsSync(cachePath)) return false;
    return validateAgentOutput(fs.readFileSync(cachePath, "utf8").trim());
  };

  const MAX_AGENT_RETRIES = 2;
  const agents = [
    { name: "pm-agent", cache: prdCache, suffix: "pm", label: "PRD" },
    { name: "designer-agent", cache: designCache, suffix: "designer", label: "Design" },
  ];

  for (const agent of agents) {
    if (isCacheValid(agent.cache)) {
      console.log(`[${ticketId}] ${agent.label} cached and valid, skipping ${agent.name}`);
      continue;
    }
    for (let attempt = 1; attempt <= MAX_AGENT_RETRIES; attempt++) {
      console.log(`[${ticketId}] Spawning ${agent.name}... (attempt ${attempt}/${MAX_AGENT_RETRIES})`);
      try {
        const ok = await runAndValidate(agent.name, agent.cache, agent.suffix);
        if (ok) break;
      } catch (err) {
        console.error(`[${ticketId}] ${agent.name} error: ${err.message}`);
      }
      if (attempt === MAX_AGENT_RETRIES) {
        throw new Error(`${agent.name} failed validation after ${MAX_AGENT_RETRIES} attempts`);
      }
      // Delete invalid cache before retry
      if (fs.existsSync(agent.cache)) fs.unlinkSync(agent.cache);
    }
  }

  // Step 2: Read cached outputs
  const prdContent = fs.readFileSync(prdCache, "utf8").trim();
  const designContent = fs.readFileSync(designCache, "utf8").trim();

  // Step 3: Orchestrator runs /opsx:ff with combined context
  console.log(`[${ticketId}] Starting orchestrator (/opsx:ff)...`);
  let orchestratorPrompt = `${ticketContext}

## PRD (from PM agent)

${prdContent}

## Design Guidance (from Designer agent)

${designContent}
`;

  if (sourceAnalysis) {
    orchestratorPrompt += `
## Source Analysis (from original project)

This is a PORT from an existing project. The source analysis below describes the original feature.
Do NOT copy source code. Use it as context for understanding requirements and data models.

${sourceAnalysis}
`;
  }

  orchestratorPrompt += `
## Your task

Run \`/opsx:ff ${titleSlug}\` — incorporate the PRD and design guidance above as context.

This creates the OpenSpec artifacts: proposal.md, design.md, specs, and tasks.

After \`/opsx:ff\` completes, output a summary listing:
- Each artifact file created and a one-line description
- All acceptance criteria (numbered)
- Out-of-scope items

Do NOT run \`/opsx:apply\`. Stop after artifacts are created.
Stage and commit all changes before finishing.

You have FULL write permissions to ALL directories including \`openspec/\`, \`lib/\`, and \`test/\`. Do NOT ask for permission — just execute tools directly. All permission checks are bypassed.
`;

  await runAsync(
    CLAUDE_BIN, ["--print", "--dangerously-skip-permissions", "--model", "opus", "--name", `${ticketId}-orchestrator`],
    { input: orchestratorPrompt, cwd: worktreePath, env: { ...process.env, GIT_WORK_TREE: worktreePath }, timeout: CLAUDE_TIMEOUT_MS, ticketId, threadTs, channelId }
  );
  console.log(`[${ticketId}] Orchestrator done.`);
}

function isRecentlyQueued(ticketId) {
  const ts = recentTickets.get(ticketId);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) { recentTickets.delete(ticketId); return false; }
  return true;
}

function waitForApproval(threadTs, timeoutMs = 60 * 60 * 1000, ticketId = null) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(threadTs);
      if (ticketId) ticketApprovals.delete(ticketId);
      resolve({ approved: false, extra: "" });
    }, timeoutMs);
    const resolver = (val) => {
      clearTimeout(timer);
      pendingApprovals.delete(threadTs);
      if (ticketId) ticketApprovals.delete(ticketId);
      resolve(val);
    };
    pendingApprovals.set(threadTs, { resolve: resolver });
    // Also register by ticketId so web UI can resolve
    if (ticketId) ticketApprovals.set(ticketId, { resolve: resolver });
  });
}

function waitForConfirmation(threadTs, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirmations.delete(threadTs);
      resolve({ choice: "reuse", messageTs: null }); // default to reuse on timeout
    }, timeoutMs);
    pendingConfirmations.set(threadTs, { resolve: (val) => { clearTimeout(timer); resolve(val); } });
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

// --- Cancel handler ---
async function handleCancel(ticketId, channelId, threadTs, messageTs, client) {
  try { await client.reactions.add({ channel: channelId, timestamp: messageTs, name: "x" }); } catch (_) {}
  const active = activeProcesses.get(ticketId);
  if (!active) {
    await postThread(client, channelId, threadTs, `No running job found for \`${ticketId}\`.`);
    return;
  }
  active.proc.kill("SIGTERM");
  cancelledTickets.add(ticketId);
  activeProcesses.delete(ticketId);
  recentTickets.delete(ticketId);
  // Clean up pending approval using the thread_ts from the active process entry if available
  const approvalThreadTs = active.threadTs || threadTs;
  pendingApprovals.delete(approvalThreadTs);

  // Force-remove local worktree and branch
  const worktreePath = path.join(WORKTREE_BASE, ticketId);
  const branch = `feat/${ticketId}`;
  if (fs.existsSync(worktreePath)) {
    spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: REPO_ROOT, encoding: "utf8" });
  }
  spawnSync("git", ["branch", "-D", branch], { cwd: REPO_ROOT, encoding: "utf8" });

  await postThread(client, channelId, threadTs, `Cancelled \`${ticketId}\`. Worktree and branch \`${branch}\` removed.`);
}

// --- Shared worktree helper: create-or-reuse ---
function ensureWorktree(ticketId) {
  const branch = `feat/${ticketId}`;
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

  // Copy .claude/settings.local.json from main repo (permissions don't travel with git)
  const srcSettings = path.join(REPO_ROOT, ".claude", "settings.local.json");
  const dstDir = path.join(worktreePath, ".claude");
  const dstSettings = path.join(dstDir, "settings.local.json");
  if (fs.existsSync(srcSettings) && !fs.existsSync(dstSettings)) {
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(srcSettings, dstSettings);
  }

  return { worktreePath, branch, created: true };
}

// Interactive version: asks user if existing worktree should be recreated
async function ensureWorktreeInteractive(ticketId, channelId, threadTs, client) {
  const branch = `feat/${ticketId}`;
  const worktreePath = path.join(WORKTREE_BASE, ticketId);

  if (fs.existsSync(worktreePath)) {
    const head = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, encoding: "utf8" });
    const currentBranch = (head.stdout || "").trim();
    if (currentBranch === branch) {
      await postThread(client, channelId, threadTs,
        `Worktree for \`${ticketId}\` already exists on branch \`${branch}\`.\n` +
        `Reply \`recreate\` to delete and rebuild, or \`reuse\` to continue with existing.`
      );
      const { choice, messageTs: confirmTs } = await waitForConfirmation(threadTs);
      if (confirmTs) {
        try { await client.reactions.add({ channel: channelId, timestamp: confirmTs, name: "white_check_mark" }); } catch (_) {}
      }
      if (choice === "recreate") {
        await postThread(client, channelId, threadTs, `Deleting worktree and branch \`${branch}\`...`);
        spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: REPO_ROOT, encoding: "utf8" });
        spawnSync("git", ["branch", "-D", branch], { cwd: REPO_ROOT, encoding: "utf8" });
      }
    }
  }

  return ensureWorktree(ticketId);
}

// --- Confirmation handler for worktree recreate/reuse (PM) ---
pmApp.message(async ({ message, next }) => {
  if (!message.thread_ts) return await next();
  const pending = pendingConfirmations.get(message.thread_ts);
  if (!pending) return await next();
  const text = stripMention(message.text).toLowerCase();
  if (text === "recreate") {
    pendingConfirmations.delete(message.thread_ts);
    pending.resolve({ choice: "recreate", messageTs: message.ts });
  } else if (text === "reuse") {
    pendingConfirmations.delete(message.thread_ts);
    pending.resolve({ choice: "reuse", messageTs: message.ts });
  }
  await next();
});

// ===================================================================
// PM Agent — app_mention handler
// ===================================================================
pmApp.event("app_mention", async ({ event, client }) => {
  if (parseFloat(event.ts) < startupTs) return; // ignore events from before startup
  const text = stripMention(event.text);
  const channelId = event.channel;
  const messageTs = event.ts;
  const threadTs = event.thread_ts || event.ts;
  const requesterId = event.user;

  const prdMatch = text.match(/^prd\s+([A-Z]+-\d+)$/i);
  const ffMatch = text.match(/^ff\s+([A-Z]+-\d+)(?:\s*:\s*([\s\S]+))?$/i);
  const portMatch = text.match(/^port\s+([A-Z]+-\d+)$/i);
  const portffMatch = text.match(/^portff\s+([A-Z]+-\d+)(?:\s*:\s*([\s\S]+))?$/i);
  const cancelMatch = text.match(/^cancel\s+([A-Z]+-\d+)$/i);
  const isUpdate = /^update/i.test(text);

  if (prdMatch) {
    const ticketId = prdMatch[1].toUpperCase();
    try { await client.reactions.add({ channel: channelId, timestamp: messageTs, name: "memo" }); } catch (_) {}
    await postThread(client, channelId, threadTs, `Generating PRD + OpenSpec artifacts for \`${ticketId}\`...`);

    queue.add(async () => {
      agentEvents.emit("job:start", { ticketId, type: "prd", user: requesterId, ts: new Date().toISOString() });
      agentEvents.emit("queue:update", { size: queue.size + queue.pending });
      let worktreePath, branch;
      try {
        // Fetch ticket
        agentEvents.emit("job:step", { ticketId, step: "fetch-ticket" });
        run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });

        // Create or reuse worktree with feature branch (asks user if exists)
        agentEvents.emit("job:step", { ticketId, step: "worktree" });
        ({ worktreePath, branch } = await ensureWorktreeInteractive(ticketId, channelId, threadTs, client));

        // Check if artifacts already exist (must have proposal.md to be considered complete)
        agentEvents.emit("job:step", { ticketId, step: "check-artifacts" });
        const changesDir = path.join(worktreePath, "openspec", "changes");
        const { hasArtifacts, dirs: existingArtifacts } = checkArtifacts(changesDir);

        if (hasArtifacts) {
          await postThread(client, channelId, threadTs,
            `OpenSpec artifacts already exist: \`${existingArtifacts.join("`, `")}\`\nSkipping generation.`
          );
        } else {
          if (cancelledTickets.has(ticketId)) throw new Error("Cancelled");
          agentEvents.emit("job:step", { ticketId, step: "pm-agent" });
          await postThread(client, channelId, threadTs, `PM + Designer agents working on \`${branch}\`...`);
          await runPMPhase(ticketId, worktreePath, channelId, threadTs);

          // Ensure artifacts are committed and pushed (safety net)
          agentEvents.emit("job:step", { ticketId, step: "push-artifacts" });
          spawnSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf8" });
          spawnSync("git", ["commit", "-m", `chore: add openspec artifacts for ${ticketId}`], { cwd: worktreePath, encoding: "utf8" });
          run("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
        }

        // Post artifact contents to Slack (both skip and generate paths)
        await postArtifactsToSlack(changesDir, client, channelId, threadTs);
        agentEvents.emit("job:complete", { ticketId, outcome: "success" });

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
        if (cancelledTickets.has(ticketId)) {
          console.log(`[PRD ${ticketId}] cancelled.`);
          return;
        }
        console.error(`[PRD ${ticketId}] failed:`, err.message);
        agentEvents.emit("job:error", { ticketId, error: err.message });
        await postThread(client, channelId, threadTs, `PRD generation failed: ${err.message}`);
      } finally {
        cancelledTickets.delete(ticketId);
        agentEvents.emit("queue:update", { size: queue.size + queue.pending });
      }
    });

  } else if (ffMatch) {
    const ticketId = ffMatch[1].toUpperCase();
    const extraInstructions = ffMatch[2] ? ffMatch[2].trim() : null;
    try { await client.reactions.add({ channel: channelId, timestamp: messageTs, name: "rocket" }); } catch (_) {}
    await postThread(client, channelId, threadTs, `FF mode: generating artifacts for \`${ticketId}\` then handing off to Dev...`);

    queue.add(async () => {
      agentEvents.emit("job:start", { ticketId, type: "ff", user: requesterId, ts: new Date().toISOString() });
      agentEvents.emit("queue:update", { size: queue.size + queue.pending });
      let worktreePath, branch;
      try {
        // Fetch ticket
        agentEvents.emit("job:step", { ticketId, step: "fetch-ticket" });
        run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });

        // Create or reuse worktree with feature branch (asks user if exists)
        agentEvents.emit("job:step", { ticketId, step: "worktree" });
        ({ worktreePath, branch } = await ensureWorktreeInteractive(ticketId, channelId, threadTs, client));

        // Check if artifacts already exist (must have proposal.md to be considered complete)
        agentEvents.emit("job:step", { ticketId, step: "check-artifacts" });
        const changesDir = path.join(worktreePath, "openspec", "changes");
        const { hasArtifacts, dirs: existingArtifacts } = checkArtifacts(changesDir);

        if (hasArtifacts) {
          await postThread(client, channelId, threadTs,
            `OpenSpec artifacts already exist: \`${existingArtifacts.join("`, `")}\`\nSkipping PM agent, handing off to Dev directly.`
          );
        } else {
          // Run PM + Designer agents
          if (cancelledTickets.has(ticketId)) throw new Error("Cancelled");
          agentEvents.emit("job:step", { ticketId, step: "pm-agent" });
          await postThread(client, channelId, threadTs, `PM + Designer agents working on \`${branch}\`...`);
          await runPMPhase(ticketId, worktreePath, channelId, threadTs);

          // Ensure artifacts are committed and pushed
          spawnSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf8" });
          spawnSync("git", ["commit", "-m", `chore: add openspec artifacts for ${ticketId}`], { cwd: worktreePath, encoding: "utf8" });
          run("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
        }

        // Post artifact contents to Slack (both skip and generate paths)
        await postArtifactsToSlack(changesDir, client, channelId, threadTs);

        // Register ff state before triggering dev
        ffTickets.add(ticketId);
        if (extraInstructions) {
          ffTicketExtras.set(ticketId, extraInstructions);
        }

        // Hand off to Dev Bot by posting a mention in the same thread
        await postThread(client, channelId, threadTs, `<@${devBotUserId}> dev ${ticketId}`);

      } catch (err) {
        if (cancelledTickets.has(ticketId)) {
          console.log(`[FF ${ticketId}] cancelled.`);
          ffTickets.delete(ticketId);
          ffTicketExtras.delete(ticketId);
          return;
        }
        console.error(`[FF ${ticketId}] failed:`, err.message);
        ffTickets.delete(ticketId);
        ffTicketExtras.delete(ticketId);
        agentEvents.emit("job:error", { ticketId, error: err.message });
        await postThread(client, channelId, threadTs, `FF mode failed (PM phase): ${err.message}`);
      } finally {
        cancelledTickets.delete(ticketId);
      }
    });

  } else if (portMatch || portffMatch) {
    const isPortFF = !!portffMatch;
    const ticketId = (portMatch || portffMatch)[1].toUpperCase();
    const extraInstructions = isPortFF && portffMatch[2] ? portffMatch[2].trim() : null;

    if (!ORIGINAL_PROJECT_PATH) {
      await postThread(client, channelId, threadTs, "`originalProjectPath` not found in `REPO_ROOT/.claude/port-settings.json` — run `/port` in the target repo first.");
      return;
    }

    const emoji = isPortFF ? "rocket" : "ship";
    try { await client.reactions.add({ channel: channelId, timestamp: messageTs, name: emoji }); } catch (_) {}
    const modeLabel = isPortFF ? "Port-FF" : "Port";
    await postThread(client, channelId, threadTs, `${modeLabel} mode: exploring original project + generating artifacts for \`${ticketId}\`...`);

    queue.add(async () => {
      let worktreePath, branch;
      try {
        // Fetch ticket
        run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });

        // Create or reuse worktree
        ({ worktreePath, branch } = await ensureWorktreeInteractive(ticketId, channelId, threadTs, client));

        // Check if artifacts already exist
        const changesDir = path.join(worktreePath, "openspec", "changes");
        const { hasArtifacts, dirs: existingArtifacts } = checkArtifacts(changesDir);

        if (hasArtifacts) {
          await postThread(client, channelId, threadTs,
            `OpenSpec artifacts already exist: \`${existingArtifacts.join("`, `")}\`\nSkipping generation.`
          );
        } else {
          if (cancelledTickets.has(ticketId)) throw new Error("Cancelled");

          // Step 1: Explore original project
          const saCache = path.join(changesDir, "port-source-analysis.md");
          let sourceAnalysis;
          if (fs.existsSync(saCache) && fs.readFileSync(saCache, "utf8").trim().length >= 50) {
            console.log(`[${ticketId}] Source analysis cached, skipping explore`);
            sourceAnalysis = fs.readFileSync(saCache, "utf8").trim();
          } else {
            await postThread(client, channelId, threadTs, `Exploring original project at \`${ORIGINAL_PROJECT_PATH}\`...`);
            sourceAnalysis = await runExplore(ticketId, worktreePath);
            safetyCommit(worktreePath, ticketId, "post-explore");
          }

          if (cancelledTickets.has(ticketId)) throw new Error("Cancelled");

          // Step 2: PM + Designer + /opsx:ff (with source analysis injected)
          await postThread(client, channelId, threadTs, `PM + Designer agents working on \`${branch}\`...`);
          await runPMPhase(ticketId, worktreePath, channelId, threadTs, { sourceAnalysis });

          // Commit + push
          spawnSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf8" });
          spawnSync("git", ["commit", "-m", `chore: add port artifacts for ${ticketId}`], { cwd: worktreePath, encoding: "utf8" });
          run("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
        }

        // Post artifacts to Slack
        const changesDir2 = path.join(worktreePath, "openspec", "changes");
        await postArtifactsToSlack(changesDir2, client, channelId, threadTs);

        // Post source analysis to Slack too
        const saPath = path.join(changesDir2, "port-source-analysis.md");
        if (fs.existsSync(saPath)) {
          const saContent = fs.readFileSync(saPath, "utf8").trim();
          const header = `*port-source-analysis.md*`;
          for (let i = 0; i < saContent.length; i += 3000) {
            const chunk = i === 0 ? `${header}\n\`\`\`\n${saContent.slice(i, i + 3000)}\n\`\`\`` : `\`\`\`\n${saContent.slice(i, i + 3000)}\n\`\`\``;
            await postThread(client, channelId, threadTs, chunk);
          }
        }

        // Post artifacts to Linear via Claude CLI (uses target repo's MCP tools)
        await postPortArtifactsToLinear(ticketId, worktreePath);

        if (isPortFF) {
          // Hand off to Dev
          ffTickets.add(ticketId);
          if (extraInstructions) ffTicketExtras.set(ticketId, extraInstructions);
          await postThread(client, channelId, threadTs, `<@${devBotUserId}> dev ${ticketId}`);
        } else {
          await postThread(client, channelId, threadTs,
            `<@${requesterId}> Port analysis for \`${ticketId}\` complete!\n\n` +
            `Artifacts posted to Linear + Slack.\n\n` +
            `*Next steps:*\n` +
            `• Leave feedback + \`update\` — PM Bot revises the specs\n` +
            `• \`dev ${ticketId}\` — Dev Agent starts implementation\n` +
            `• \`portff ${ticketId}\` — full auto port + dev + PR`
          );
        }
      } catch (err) {
        if (cancelledTickets.has(ticketId)) {
          console.log(`[${modeLabel} ${ticketId}] cancelled.`);
          if (isPortFF) { ffTickets.delete(ticketId); ffTicketExtras.delete(ticketId); }
          return;
        }
        console.error(`[${modeLabel} ${ticketId}] failed:`, err.message);
        if (isPortFF) { ffTickets.delete(ticketId); ffTicketExtras.delete(ticketId); }
        await postThread(client, channelId, threadTs, `${modeLabel} failed: ${err.message}`);
      } finally {
        cancelledTickets.delete(ticketId);
      }
    });

  } else if (isUpdate) {
    if (!event.thread_ts) return;

    // Find the ticket ID from the parent thread
    const threadContext = await fetchThreadContext(client, channelId, threadTs);
    const ticketMatch = threadContext.match(/([A-Z]+-\d+)/);
    if (!ticketMatch) {
      await postThread(client, channelId, threadTs, "Couldn't find a ticket ID in this thread.");
      return;
    }
    const ticketId = ticketMatch[1].toUpperCase();

    try { await client.reactions.add({ channel: channelId, timestamp: messageTs, name: "pencil2" }); } catch (_) {}
    await postThread(client, channelId, threadTs, `Revising PRD for \`${ticketId}\` based on feedback...`);

    queue.add(async () => {
      try {
        const fullThread = await fetchThreadContext(client, channelId, threadTs);

        // Ensure worktree exists (reuse silently — update only revises existing artifacts)
        const { worktreePath, branch } = ensureWorktree(ticketId);
        const workDir = worktreePath;

        run("python3", [BUILD_PROMPT_PY, ticketId, workDir, "revise", fullThread], { env: { ...process.env } });
        const revisePrompt = fs.readFileSync(`/tmp/agent-prompt-${ticketId}-revise.txt`, "utf8");

        await runAsync(
          CLAUDE_BIN, ["--print", "--dangerously-skip-permissions", "--name", `${ticketId}-revise`],
          { input: revisePrompt, cwd: workDir, env: { ...process.env, GIT_WORK_TREE: workDir }, timeout: CLAUDE_TIMEOUT_MS, ticketId, threadTs, channelId }
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

        // If this is a port ticket, sync updated artifacts to Linear
        const saPath = path.join(workDir, "openspec", "changes", "port-source-analysis.md");
        if (fs.existsSync(saPath)) {
          await postPortArtifactsToLinear(ticketId, workDir);
          await postThread(client, channelId, threadTs, "Updated artifacts also synced to Linear.");
        }

        await postThread(client, channelId, threadTs,
          `Specs revised and pushed to \`${branch}\`!\n` +
          `• More feedback + \`update\` to revise again\n` +
          `• \`dev ${ticketId}\` to start implementation`
        );
      } catch (err) {
        if (cancelledTickets.has(ticketId)) {
          console.log(`[PRD revise ${ticketId}] cancelled.`);
          return;
        }
        console.error(`[PRD revise ${ticketId}] failed:`, err.message);
        await postThread(client, channelId, threadTs, `Revision failed: ${err.message}`);
      } finally {
        cancelledTickets.delete(ticketId);
      }
    });

  } else if (cancelMatch) {
    const ticketId = cancelMatch[1].toUpperCase();
    await handleCancel(ticketId, channelId, threadTs, messageTs, client);

  } else {
    // Unknown command — silently ignore or optionally send help
  }
});

// ===================================================================
// Dev Agent
// ===================================================================

// --- Confirmation handler for worktree recreate/reuse (Dev) ---
devApp.message(async ({ message, next }) => {
  if (!message.thread_ts) return await next();
  const pending = pendingConfirmations.get(message.thread_ts);
  if (!pending) return await next();
  const text = stripMention(message.text).toLowerCase();
  if (text === "recreate") {
    pendingConfirmations.delete(message.thread_ts);
    pending.resolve({ choice: "recreate", messageTs: message.ts });
  } else if (text === "reuse") {
    pendingConfirmations.delete(message.thread_ts);
    pending.resolve({ choice: "reuse", messageTs: message.ts });
  }
  await next();
});

// --- Approval handler (kept as message listener — thread replies, no mention needed) ---
devApp.message(async ({ message, next }) => {
  if (!message.thread_ts) return await next();
  const pending = pendingApprovals.get(message.thread_ts);
  if (!pending) return await next();
  const text = stripMention(message.text);
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

// --- app_mention handler for dev commands ---
devApp.event("app_mention", async ({ event, client }) => {
  if (parseFloat(event.ts) < startupTs) return; // ignore events from before startup
  const text = stripMention(event.text);
  const channelId = event.channel;
  const messageTs = event.ts;
  const threadTs = event.thread_ts || event.ts;
  const isFromThread = !!event.thread_ts;

  const devMatch = text.match(/^(?:dev\s+)?([A-Z]+-\d+)$/i);
  const cancelMatch = text.match(/^cancel\s+([A-Z]+-\d+)$/i);

  if (devMatch) {
    const ticketId = devMatch[1].toUpperCase();

    try { await client.reactions.add({ channel: channelId, timestamp: messageTs, name: "eyes" }); } catch (_) {}

    if (isRecentlyQueued(ticketId)) {
      await postThread(client, channelId, threadTs, `Already working on \`${ticketId}\`. Check the thread above.`);
      return;
    }

    recentTickets.set(ticketId, Date.now());

    const isFF = ffTickets.has(ticketId);

    // Fetch thread context if triggered from an existing thread (skip in FF — artifacts are in worktree)
    let threadContext = "";
    if (isFF) {
      await postThread(client, channelId, threadTs,
        `Queued \`${ticketId}\` — continuing from FF mode.`
      );
    } else if (isFromThread) {
      threadContext = await fetchThreadContext(client, channelId, threadTs);
      await postThread(client, channelId, threadTs,
        `Queued \`${ticketId}\` — incorporating thread context into development.`
      );
    } else {
      await postThread(client, channelId, threadTs,
        `Queued \`${ticketId}\` — I'll update this thread as I go.`
      );
    }

    queue.add(() => runDevJob(ticketId, channelId, threadTs, client, threadContext, { isFF, isFromThread }));

  } else if (cancelMatch) {
    const ticketId = cancelMatch[1].toUpperCase();
    await handleCancel(ticketId, channelId, threadTs, messageTs, client);

  } else {
    // Unknown command — silently ignore
  }
});

// --- Main dev job runner ---
async function runDevJob(ticketId, channelId, threadTs, client, threadContext, opts = {}) {
  let jobTimedOut = false;
  const jobTimer = setTimeout(() => { jobTimedOut = true; }, JOB_TIMEOUT_MS);

  let worktreePath, branch;
  agentEvents.emit("job:start", { ticketId, type: opts.isFF ? "ff-dev" : "dev", user: "slack", ts: new Date().toISOString() });
  agentEvents.emit("queue:update", { size: queue.size + queue.pending });

  try {
    // Step 1: Fetch ticket + Linear update (skip fetch if FF already has it)
    if (cancelledTickets.has(ticketId)) throw new Error("Cancelled");
    agentEvents.emit("job:step", { ticketId, step: "fetch-ticket" });
    const ticketCachePath = `/tmp/ticket-${ticketId}.json`;
    if (opts.isFF && fs.existsSync(ticketCachePath)) {
      await postThread(client, channelId, threadTs, `Ticket \`${ticketId}\` already fetched, updating Linear...`);
    } else {
      await postThread(client, channelId, threadTs, `Fetching ticket \`${ticketId}\`...`);
      run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });
    }
    run("python3", [LINEAR_UPDATE_PY, ticketId], { env: { ...process.env } });

    if (cancelledTickets.has(ticketId)) throw new Error("Cancelled");
    if (jobTimedOut) throw new Error("Job timed out");

    // Step 2: Create or reuse worktree with feature branch
    agentEvents.emit("job:step", { ticketId, step: "worktree" });
    await postThread(client, channelId, threadTs, `Preparing workspace...`);
    if (opts.isFF || opts.isFromThread) {
      // FF mode or thread trigger: worktree already exists, skip interactive confirmation
      ({ worktreePath, branch } = ensureWorktree(ticketId));
    } else {
      ({ worktreePath, branch } = await ensureWorktreeInteractive(ticketId, channelId, threadTs, client));
    }

    if (jobTimedOut) throw new Error("Job timed out");

    // Step 3: Check if openspec artifacts already exist (must have proposal.md)
    agentEvents.emit("job:step", { ticketId, step: "check-artifacts" });
    const changesDir = path.join(worktreePath, "openspec", "changes");
    const { hasArtifacts, dirs: existing } = checkArtifacts(changesDir);

    if (hasArtifacts) {
      if (opts.isFF) {
        await postThread(client, channelId, threadTs,
          `OpenSpec artifacts already exist: \`${existing.join("`, `")}\`\nSkipping artifact generation, starting implementation...`
        );
      } else {
        await postThread(client, channelId, threadTs,
          `OpenSpec artifacts already exist: \`${existing.join("`, `")}\`\n` +
          `Skipping artifact generation.\nReply \`approve\` to start implementation, or \`reject\` to cancel.\nYou can also reply \`approve: <extra instructions>\`.`
        );
      }
    } else {
      await postThread(client, channelId, threadTs, `PM + Designer agents generating artifacts...`);
      await runPMPhase(ticketId, worktreePath, channelId, threadTs);

      if (jobTimedOut) throw new Error("Job timed out");

      // P6: Post full artifacts + commit/push so user can review before approving
      if (!opts.isFF) {
        spawnSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf8" });
        spawnSync("git", ["commit", "-m", `chore: add openspec artifacts for ${ticketId}`], { cwd: worktreePath, encoding: "utf8" });
        run("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
        await postArtifactsToSlack(changesDir, client, channelId, threadTs);
      }

      if (opts.isFF) {
        await postThread(client, channelId, threadTs, `Artifacts generated, starting implementation...`);
      } else {
        await postThread(client, channelId, threadTs,
          `Artifacts ready! Review above, then reply \`approve\` to start implementation, or \`reject\` to cancel.\nYou can also reply \`approve: <extra instructions>\`.`
        );
      }
    }

    agentEvents.emit("approval:pending", { ticketId });
    let approved, extra;
    if (opts.isFF) {
      // FF mode: auto-approve, no user interaction needed
      approved = true;
      extra = "";
      // Read and consume ff extra instructions if any
      const ffExtra = ffTicketExtras.get(ticketId);
      if (ffExtra) {
        extra = ffExtra;
        ffTicketExtras.delete(ticketId);
      }
      agentEvents.emit("approval:resolved", { ticketId, decision: "auto-approved" });
    } else {
      ({ approved, extra } = await waitForApproval(threadTs, undefined, ticketId));
      agentEvents.emit("approval:resolved", { ticketId, decision: approved ? "approved" : "rejected" });
      if (!approved) {
        await postThread(client, channelId, threadTs, `Cancelled \`${ticketId}\`.`);
        return;
      }
    }

    // Branch already exists from ensureWorktree — verify
    const currentBranch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath }).trim();
    await postThread(client, channelId, threadTs, `Working on branch \`${currentBranch}\`...`);

    // Skill runner with retry (transient errors) + resume on timeout
    const MAX_RESUMES = 3;
    const runSkill = async (label, prompt, retries = 2) => {
      console.log(`[${ticketId}] Starting ${label}...`);
      await postThread(client, channelId, threadTs, `Running \`${label}\`...`);
      const sessionName = `${ticketId}-${label}`;
      const isAgent = label === "dev-agent";
      let isResume = false;

      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
          let args;
          if (isResume) {
            args = isAgent
              ? ["--print", "--dangerously-skip-permissions", "--resume", sessionName]
              : ["--print", "--dangerously-skip-permissions", "--model", "opus", "--resume", sessionName];
          } else if (isAgent) {
            args = ["--print", "--dangerously-skip-permissions", "--agent", label, "--name", sessionName];
          } else {
            args = ["--print", "--dangerously-skip-permissions", "--model", "opus", "--name", sessionName];
          }
          const input = isResume ? "Continue where you left off. Complete the remaining work." : prompt;

          const out = await runAsync(
            CLAUDE_BIN, args,
            { input, cwd: worktreePath, env: { ...process.env, GIT_WORK_TREE: worktreePath }, timeout: CLAUDE_TIMEOUT_MS, ticketId, threadTs, channelId }
          );
          if (jobTimedOut) throw new Error("Job timed out");
          console.log(`[${ticketId}] ${label} done.`);
          return out;
        } catch (err) {
          if (cancelledTickets.has(ticketId)) throw err;

          const isTimeout = err.message.includes("timed out");
          const isTransient = err.message.includes("500") || err.message.includes("Internal server error") || err.message.includes("529");

          if (isTimeout && attempt <= MAX_RESUMES) {
            // Timeout: safety commit partial work, push, then resume session
            safetyCommit(worktreePath, ticketId, `${label} timeout`);
            try { run("git", ["push", "origin", "HEAD", "--force-with-lease"], { cwd: worktreePath }); } catch (_) {}
            await postThread(client, channelId, threadTs, `\`${label}\` timed out, resuming session... (attempt ${attempt}/${MAX_RESUMES})`);
            isResume = true;
            continue;
          } else if (isTransient && attempt <= retries) {
            const wait = attempt * 15000;
            await postThread(client, channelId, threadTs, `\`${label}\` hit a transient API error, retrying in ${wait / 1000}s... (attempt ${attempt}/${retries})`);
            await new Promise(r => setTimeout(r, wait));
          } else { throw err; }
        }
      }
    };

    // Build apply prompt with extra instructions (FF: only user instructions; manual: thread context)
    let applyExtra = extra;
    if (!opts.isFF && threadContext && !applyExtra) {
      applyExtra = `The following Slack thread context may contain relevant feedback:\n${threadContext}`;
    } else if (!opts.isFF && threadContext && applyExtra) {
      applyExtra = `${applyExtra}\n\nSlack thread context:\n${threadContext}`;
    }

    // Step 4b: dev-agent (opsx:apply + verify + test)
    agentEvents.emit("job:step", { ticketId, step: "dev-agent" });
    const { dirs: artifactDirs } = checkArtifacts(changesDir);
    const artifactSlug = artifactDirs[0] || "";
    const devContext = buildTicketContext(ticketId, worktreePath, applyExtra);
    const devPrompt = `${devContext}

## Your task

Run \`/opsx:apply ${artifactSlug}\` to implement the changes described in the OpenSpec artifacts at \`openspec/changes/${artifactSlug}/\`.

After applying, run \`/opsx:verify\` to validate the implementation.
Then run any relevant tests.

Stage and commit all changes before finishing.

You have FULL write permissions to ALL directories including \`openspec/\`, \`lib/\`, and \`test/\`. Do NOT ask for permission — just execute tools directly. All permission checks are bypassed.
`;
    await runSkill("dev-agent", devPrompt);
    safetyCommit(worktreePath, ticketId, "after opsx:apply");
    run("git", ["push", "origin", "HEAD", "--force-with-lease"], { cwd: worktreePath });

    // Step 5: /commit
    agentEvents.emit("job:step", { ticketId, step: "commit" });
    await runSkill("commit", `/commit\n\nDo not ask for confirmation. Commit all changes automatically.\nIMPORTANT: You are working in a git worktree at ${worktreePath} on branch ${branch}. All git commands must run inside this directory. Do NOT commit to any other branch or directory.`);
    safetyCommit(worktreePath, ticketId, "after /commit");
    run("git", ["push", "origin", "HEAD", "--force-with-lease"], { cwd: worktreePath });

    // Step 6: /format
    agentEvents.emit("job:step", { ticketId, step: "format" });
    await runSkill("format", `/format\n\nDo not ask for confirmation. Format and commit automatically.\nIMPORTANT: You are working in a git worktree at ${worktreePath} on branch ${branch}. All git commands must run inside this directory.`);
    safetyCommit(worktreePath, ticketId, "after /format");
    run("git", ["push", "origin", "HEAD", "--force-with-lease"], { cwd: worktreePath });

    // Step 7: archive openspec, commit any remaining changes, push + create PR
    agentEvents.emit("job:step", { ticketId, step: "push-pr" });
    await postThread(client, channelId, threadTs, `Pushing and creating PR...`);
    const changesDir2 = path.join(worktreePath, "openspec", "changes");
    const archiveDir = path.join(changesDir2, "archive");
    if (fs.existsSync(changesDir2)) {
      fs.mkdirSync(archiveDir, { recursive: true });
      const toArchive = fs.readdirSync(changesDir2)
        .filter(d => d !== "archive" && d !== ".gitkeep" && fs.statSync(path.join(changesDir2, d)).isDirectory());
      for (const dir of toArchive) {
        const src = path.join(changesDir2, dir);
        const dst = path.join(archiveDir, dir);
        spawnSync("mv", [src, dst], { cwd: worktreePath, encoding: "utf8" });
      }
    }
    spawnSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf8" });
    const hasStagedChanges = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: worktreePath, encoding: "utf8" }).status !== 0;
    if (hasStagedChanges) {
      spawnSync("git", ["commit", "-m", `chore: archive openspec artifacts for ${ticketId}`], { cwd: worktreePath, encoding: "utf8" });
    }
    run("git", ["push", "origin", "HEAD", "--force-with-lease"], { cwd: worktreePath });
    run("python3", [path.join(worktreePath, CREATE_PR_PY_NAME)], { cwd: worktreePath, env: { ...process.env, TICKET_ID: ticketId } });
    if (jobTimedOut) throw new Error("Job timed out");

    const prUrlFile = `/tmp/pr-url-${ticketId}.txt`;
    let prUrl = "";
    if (fs.existsSync(prUrlFile)) { prUrl = fs.readFileSync(prUrlFile, "utf8").trim(); }

    // Step 8: /code-review
    agentEvents.emit("job:step", { ticketId, step: "code-review" });
    const reviewOut = await runSkill("code-review", `/code-review\n\nAfter generating the review, automatically post it as a comment on the PR. Do not ask for confirmation.\nIMPORTANT: You are working in a git worktree at ${worktreePath} on branch ${branch}.`);
    const reviewTruncated = reviewOut.trim().slice(-2000) || "(no output)";
    await postThread(client, channelId, threadTs, `Code review:\n\`\`\`\n${reviewTruncated}\n\`\`\``);

    const successMsg = prUrl
      ? `All done! PR ready: ${prUrl}`
      : `All done! \`${ticketId}\` implementation complete.`;
    agentEvents.emit("job:complete", { ticketId, outcome: "success", prUrl });
    await postThread(client, channelId, threadTs, successMsg);

    const sessionId = getLatestSessionId();
    if (sessionId) {
      await postThread(client, channelId, threadTs,
        `To continue in terminal:\n\`\`\`\ncd ${worktreePath}\nclaude --resume ${ticketId}-dev-agent\n\`\`\`\nAll sessions: \`${ticketId}-dev-agent\`, \`${ticketId}-commit\`, \`${ticketId}-format\`, \`${ticketId}-code-review\``
      );
    }
  } catch (err) {
    if (cancelledTickets.has(ticketId)) {
      console.log(`[${ticketId}] Job cancelled.`);
      agentEvents.emit("job:complete", { ticketId, outcome: "cancelled" });
      return;
    }
    agentEvents.emit("job:error", { ticketId, error: err.message });
    // Safety commit on failure — preserve any partial implementation
    if (worktreePath && fs.existsSync(worktreePath)) {
      safetyCommit(worktreePath, ticketId, "on failure");
      // Push partial work so it's not lost
      try {
        run("git", ["push", "origin", "HEAD", "--force-with-lease"], { cwd: worktreePath });
        await postThread(client, channelId, threadTs,
          `Failed on \`${ticketId}\`: ${err.message}\nPartial work committed and pushed to \`${branch}\`.\nWorktree preserved at \`${worktreePath}\` for debugging.`
        );
      } catch (_) {
        await postThread(client, channelId, threadTs,
          `Failed on \`${ticketId}\`: ${err.message}\nWorktree preserved at \`${worktreePath}\` for debugging.`
        );
      }
    } else {
      console.error(`[${ticketId}] Job failed:`, err.message);
      await postThread(client, channelId, threadTs, `Failed on \`${ticketId}\`: ${err.message}`);
    }
  } finally {
    clearTimeout(jobTimer);
    cleanupTicket(ticketId);
  }
}

// --- Web API: exported functions for web.js to trigger jobs ---
function triggerFF(ticketId, instructions) {
  if (isRecentlyQueued(ticketId)) return { ok: false, error: "Already queued" };
  recentTickets.set(ticketId, Date.now());
  ffTickets.add(ticketId);
  if (instructions) ffTicketExtras.set(ticketId, instructions);

  queue.add(async () => {
    agentEvents.emit("job:start", { ticketId, type: "ff", user: "web", ts: new Date().toISOString() });
    agentEvents.emit("queue:update", { size: queue.size + queue.pending });
    let worktreePath, branch;
    try {
      agentEvents.emit("job:step", { ticketId, step: "fetch-ticket" });
      run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });
      agentEvents.emit("job:step", { ticketId, step: "worktree" });
      ({ worktreePath, branch } = ensureWorktree(ticketId));

      agentEvents.emit("job:step", { ticketId, step: "check-artifacts" });
      const changesDir = path.join(worktreePath, "openspec", "changes");
      const { hasArtifacts } = checkArtifacts(changesDir);

      if (!hasArtifacts) {
        if (cancelledTickets.has(ticketId)) throw new Error("Cancelled");
        agentEvents.emit("job:step", { ticketId, step: "pm-agent" });
        await runPMPhase(ticketId, worktreePath, null, null);
        spawnSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf8" });
        spawnSync("git", ["commit", "-m", `chore: add openspec artifacts for ${ticketId}`], { cwd: worktreePath, encoding: "utf8" });
        run("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
      }

      // Hand off to dev (inline, not via Slack mention)
      await runDevJob(ticketId, null, ticketId, webClient, "", { isFF: true, isFromThread: false });
    } catch (err) {
      if (!cancelledTickets.has(ticketId)) {
        agentEvents.emit("job:error", { ticketId, error: err.message });
      }
      ffTickets.delete(ticketId);
      ffTicketExtras.delete(ticketId);
    } finally {
      cancelledTickets.delete(ticketId);
      agentEvents.emit("queue:update", { size: queue.size + queue.pending });
    }
  });
  return { ok: true };
}

function triggerDev(ticketId) {
  if (isRecentlyQueued(ticketId)) return { ok: false, error: "Already queued" };
  recentTickets.set(ticketId, Date.now());
  queue.add(() => runDevJob(ticketId, null, ticketId, webClient, "", { isFF: false, isFromThread: false }));
  return { ok: true };
}

function triggerPRD(ticketId) {
  if (isRecentlyQueued(ticketId)) return { ok: false, error: "Already queued" };
  recentTickets.set(ticketId, Date.now());

  queue.add(async () => {
    agentEvents.emit("job:start", { ticketId, type: "prd", user: "web", ts: new Date().toISOString() });
    agentEvents.emit("queue:update", { size: queue.size + queue.pending });
    let worktreePath, branch;
    try {
      agentEvents.emit("job:step", { ticketId, step: "fetch-ticket" });
      run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });
      agentEvents.emit("job:step", { ticketId, step: "worktree" });
      ({ worktreePath, branch } = ensureWorktree(ticketId));

      agentEvents.emit("job:step", { ticketId, step: "check-artifacts" });
      const changesDir = path.join(worktreePath, "openspec", "changes");
      const { hasArtifacts } = checkArtifacts(changesDir);

      if (hasArtifacts) {
        agentEvents.emit("job:log", { ticketId, source: "system", message: "Artifacts already exist, skipping generation." });
      } else {
        if (cancelledTickets.has(ticketId)) throw new Error("Cancelled");
        agentEvents.emit("job:step", { ticketId, step: "pm-agent" });
        await runPMPhase(ticketId, worktreePath, null, null);
        agentEvents.emit("job:step", { ticketId, step: "push-artifacts" });
        spawnSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf8" });
        spawnSync("git", ["commit", "-m", `chore: add openspec artifacts for ${ticketId}`], { cwd: worktreePath, encoding: "utf8" });
        run("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
      }
      agentEvents.emit("job:complete", { ticketId, outcome: "success" });
    } catch (err) {
      if (!cancelledTickets.has(ticketId)) {
        agentEvents.emit("job:error", { ticketId, error: err.message });
      }
    } finally {
      cancelledTickets.delete(ticketId);
      agentEvents.emit("queue:update", { size: queue.size + queue.pending });
    }
  });
  return { ok: true };
}

function triggerPort(ticketId) {
  if (isRecentlyQueued(ticketId)) return { ok: false, error: "Already queued" };
  if (!ORIGINAL_PROJECT_PATH) return { ok: false, error: "originalProjectPath not found in REPO_ROOT/.claude/port-settings.json" };
  recentTickets.set(ticketId, Date.now());

  queue.add(async () => {
    agentEvents.emit("job:start", { ticketId, type: "port", user: "web", ts: new Date().toISOString() });
    agentEvents.emit("queue:update", { size: queue.size + queue.pending });
    let worktreePath, branch;
    try {
      agentEvents.emit("job:step", { ticketId, step: "fetch-ticket" });
      run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });
      agentEvents.emit("job:step", { ticketId, step: "worktree" });
      ({ worktreePath, branch } = ensureWorktree(ticketId));

      agentEvents.emit("job:step", { ticketId, step: "check-artifacts" });
      const changesDir = path.join(worktreePath, "openspec", "changes");
      const { hasArtifacts } = checkArtifacts(changesDir);

      if (!hasArtifacts) {
        if (cancelledTickets.has(ticketId)) throw new Error("Cancelled");

        // Step 1: Explore original project
        agentEvents.emit("job:step", { ticketId, step: "explore" });
        const saCache = path.join(changesDir, "port-source-analysis.md");
        let sourceAnalysis;
        if (fs.existsSync(saCache) && fs.readFileSync(saCache, "utf8").trim().length >= 50) {
          sourceAnalysis = fs.readFileSync(saCache, "utf8").trim();
        } else {
          sourceAnalysis = await runExplore(ticketId, worktreePath);
          safetyCommit(worktreePath, ticketId, "post-explore");
        }

        if (cancelledTickets.has(ticketId)) throw new Error("Cancelled");

        // Step 2: PM + Designer + /opsx:ff (with source analysis)
        agentEvents.emit("job:step", { ticketId, step: "pm-agent" });
        await runPMPhase(ticketId, worktreePath, null, null, { sourceAnalysis });
        spawnSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf8" });
        spawnSync("git", ["commit", "-m", `chore: add port artifacts for ${ticketId}`], { cwd: worktreePath, encoding: "utf8" });
        run("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
      }

      // Post artifacts to Linear via Claude CLI
      await postPortArtifactsToLinear(ticketId, worktreePath);

      agentEvents.emit("job:complete", { ticketId, outcome: "success" });
    } catch (err) {
      if (!cancelledTickets.has(ticketId)) {
        agentEvents.emit("job:error", { ticketId, error: err.message });
      }
    } finally {
      cancelledTickets.delete(ticketId);
      agentEvents.emit("queue:update", { size: queue.size + queue.pending });
    }
  });
  return { ok: true };
}

function triggerPortFF(ticketId, instructions) {
  if (isRecentlyQueued(ticketId)) return { ok: false, error: "Already queued" };
  if (!ORIGINAL_PROJECT_PATH) return { ok: false, error: "originalProjectPath not found in REPO_ROOT/.claude/port-settings.json" };
  recentTickets.set(ticketId, Date.now());
  ffTickets.add(ticketId);
  if (instructions) ffTicketExtras.set(ticketId, instructions);

  queue.add(async () => {
    agentEvents.emit("job:start", { ticketId, type: "portff", user: "web", ts: new Date().toISOString() });
    agentEvents.emit("queue:update", { size: queue.size + queue.pending });
    let worktreePath, branch;
    try {
      agentEvents.emit("job:step", { ticketId, step: "fetch-ticket" });
      run("python3", [FETCH_TICKET_PY, ticketId], { env: { ...process.env } });
      agentEvents.emit("job:step", { ticketId, step: "worktree" });
      ({ worktreePath, branch } = ensureWorktree(ticketId));

      agentEvents.emit("job:step", { ticketId, step: "check-artifacts" });
      const changesDir = path.join(worktreePath, "openspec", "changes");
      const { hasArtifacts } = checkArtifacts(changesDir);

      if (!hasArtifacts) {
        if (cancelledTickets.has(ticketId)) throw new Error("Cancelled");

        // Step 1: Explore original project
        agentEvents.emit("job:step", { ticketId, step: "explore" });
        const saCache = path.join(changesDir, "port-source-analysis.md");
        let sourceAnalysis;
        if (fs.existsSync(saCache) && fs.readFileSync(saCache, "utf8").trim().length >= 50) {
          sourceAnalysis = fs.readFileSync(saCache, "utf8").trim();
        } else {
          sourceAnalysis = await runExplore(ticketId, worktreePath);
          safetyCommit(worktreePath, ticketId, "post-explore");
        }

        if (cancelledTickets.has(ticketId)) throw new Error("Cancelled");

        // Step 2: PM + Designer + /opsx:ff (with source analysis)
        agentEvents.emit("job:step", { ticketId, step: "pm-agent" });
        await runPMPhase(ticketId, worktreePath, null, null, { sourceAnalysis });
        spawnSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf8" });
        spawnSync("git", ["commit", "-m", `chore: add port artifacts for ${ticketId}`], { cwd: worktreePath, encoding: "utf8" });
        run("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
      }

      // Post artifacts to Linear via Claude CLI
      await postPortArtifactsToLinear(ticketId, worktreePath);

      // Hand off to dev
      await runDevJob(ticketId, null, ticketId, webClient, "", { isFF: true, isFromThread: false });
    } catch (err) {
      if (!cancelledTickets.has(ticketId)) {
        agentEvents.emit("job:error", { ticketId, error: err.message });
      }
      ffTickets.delete(ticketId);
      ffTicketExtras.delete(ticketId);
    } finally {
      cancelledTickets.delete(ticketId);
      agentEvents.emit("queue:update", { size: queue.size + queue.pending });
    }
  });
  return { ok: true };
}

function cancelJob(ticketId) {
  const active = activeProcesses.get(ticketId);
  if (!active) return { ok: false, error: "No running job found" };
  active.proc.kill("SIGTERM");
  cancelledTickets.add(ticketId);
  activeProcesses.delete(ticketId);
  recentTickets.delete(ticketId);
  const approvalThreadTs = active.threadTs;
  if (approvalThreadTs) pendingApprovals.delete(approvalThreadTs);
  ticketApprovals.delete(ticketId);

  const worktreePath = path.join(WORKTREE_BASE, ticketId);
  const branch = `feat/${ticketId}`;
  if (fs.existsSync(worktreePath)) {
    spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: REPO_ROOT, encoding: "utf8" });
  }
  spawnSync("git", ["branch", "-D", branch], { cwd: REPO_ROOT, encoding: "utf8" });
  agentEvents.emit("job:complete", { ticketId, outcome: "cancelled" });
  return { ok: true };
}

function resolveApproval(ticketId, decision, instructions) {
  const pending = ticketApprovals.get(ticketId);
  if (!pending) return { ok: false, error: "No pending approval for this ticket" };
  pending.resolve({ approved: decision === "approve", extra: instructions || "" });
  return { ok: true };
}

module.exports = { triggerFF, triggerDev, triggerPRD, triggerPort, triggerPortFF, cancelJob, resolveApproval, ticketApprovals };

// --- Uncaught error handlers (prevent dashboard crashes from killing agent) ---
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT]", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED]", err && err.message ? err.message : err);
});

// --- Start both bots + web dashboard ---
(async () => {
  const [pmAuth, devAuth] = await Promise.all([
    pmApp.client.auth.test(),
    devApp.client.auth.test(),
  ]);
  pmBotUserId = pmAuth.user_id;
  devBotUserId = devAuth.user_id;

  await Promise.all([pmApp.start(), devApp.start()]);
  console.log("PM agent + Dev agent running (Socket Mode)");

  // Start web dashboard
  try {
    require("./web");
  } catch (err) {
    console.error("[web] Dashboard failed to start:", err.message);
    console.error("[web] Agent continues without dashboard.");
  }
})();
