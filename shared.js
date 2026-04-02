"use strict";

const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const CLAUDE_BIN = "/Users/yangchenghao/.local/bin/claude";
const FLUTTER_BIN = "/Users/yangchenghao/flutter/bin/flutter";
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "gogox-client-flutter");
const WORKTREE_BASE = path.join(REPO_ROOT, ".claude", "worktree");
const CLAUDE_TIMEOUT_MS = 28 * 60 * 1000;

const FETCH_TICKET_PY = path.join(__dirname, "fetch_ticket.py");
const BUILD_PROMPT_PY = path.join(__dirname, "build_prompt.py");
const LINEAR_UPDATE_PY = path.join(__dirname, "linear_update.py");
const CREATE_PR_PY = path.join(REPO_ROOT, "create_pr.py");

// Ensure flutter bin is in PATH for subprocesses
process.env.PATH = `/Users/yangchenghao/flutter/bin:${process.env.PATH}`;

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

module.exports = {
  CLAUDE_BIN, FLUTTER_BIN, REPO_ROOT, WORKTREE_BASE, CLAUDE_TIMEOUT_MS,
  FETCH_TICKET_PY, BUILD_PROMPT_PY, LINEAR_UPDATE_PY, CREATE_PR_PY,
  postThread, run, runAsync, getLatestSessionId, cleanupWorktree,
  spawnSync, fs, path,
};
