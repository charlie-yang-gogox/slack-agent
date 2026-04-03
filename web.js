"use strict";

const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const fs = require("fs");
const { agentEvents, getStatus } = require("./events");

const WEB_PORT = parseInt(process.env.WEB_PORT || "3000", 10);
const DB_DIR = path.join(__dirname, "db");
const DB_PATH = path.join(DB_DIR, "agent.db");
const MAX_SSE_CONNECTIONS = 20;
const SSE_HEARTBEAT_MS = 30000;
const EVENT_BUFFER_SIZE = 100;
const LOG_BATCH_FLUSH_MS = 500;
const LOG_BATCH_FLUSH_LINES = 50;
const MAX_LOGS_PER_JOB = 10000;
const RETENTION_MAX_JOBS = 500;
const RETENTION_MAX_DAYS = 90;

// --- SQLite setup ---
fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("user_version = 1");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticketId TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    startedAt TEXT NOT NULL,
    completedAt TEXT,
    prUrl TEXT,
    triggeredBy TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_ticketId ON jobs(ticketId);
  CREATE INDEX IF NOT EXISTS idx_jobs_startedAt ON jobs(startedAt);

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jobId INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    source TEXT,
    message TEXT NOT NULL,
    level TEXT DEFAULT 'info',
    FOREIGN KEY (jobId) REFERENCES jobs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_logs_jobId ON logs(jobId);
`);

// --- Retention cleanup on startup ---
const cutoffDate = new Date(Date.now() - RETENTION_MAX_DAYS * 24 * 60 * 60 * 1000).toISOString();
const totalJobs = db.prepare("SELECT COUNT(*) as count FROM jobs").get().count;
if (totalJobs > RETENTION_MAX_JOBS) {
  const excess = totalJobs - RETENTION_MAX_JOBS;
  db.prepare(`DELETE FROM logs WHERE jobId IN (SELECT id FROM jobs ORDER BY startedAt ASC LIMIT ?)`).run(excess);
  db.prepare(`DELETE FROM jobs WHERE id IN (SELECT id FROM jobs ORDER BY startedAt ASC LIMIT ?)`).run(excess);
}
db.prepare(`DELETE FROM logs WHERE jobId IN (SELECT id FROM jobs WHERE startedAt < ?)`).run(cutoffDate);
db.prepare(`DELETE FROM jobs WHERE startedAt < ?`).run(cutoffDate);

// --- Prepared statements ---
const insertJob = db.prepare(
  "INSERT INTO jobs (ticketId, type, status, startedAt, triggeredBy) VALUES (?, ?, ?, ?, ?)"
);
const updateJobComplete = db.prepare(
  "UPDATE jobs SET status = ?, completedAt = ?, prUrl = ?, error = ? WHERE id = ?"
);
const insertLogBatch = db.transaction((rows) => {
  const stmt = db.prepare(
    "INSERT INTO logs (jobId, timestamp, source, message, level) VALUES (?, ?, ?, ?, ?)"
  );
  for (const row of rows) {
    stmt.run(row.jobId, row.timestamp, row.source, row.message, row.level);
  }
});
const getJobByTicket = db.prepare(
  "SELECT * FROM jobs WHERE ticketId = ? ORDER BY startedAt DESC LIMIT 1"
);
const getJobHistory = db.prepare(
  "SELECT * FROM jobs ORDER BY startedAt DESC LIMIT ? OFFSET ?"
);
const getJobLogs = db.prepare(
  "SELECT * FROM logs WHERE jobId = ? ORDER BY id ASC LIMIT ?"
);
const countLogsByJob = db.prepare(
  "SELECT COUNT(*) as count FROM logs WHERE jobId = ?"
);

// --- Job ID tracking (ticketId -> SQLite job id) ---
const activeJobIds = new Map();

// --- Log write batcher ---
let logBuffer = [];
let logFlushTimer = null;

function flushLogs() {
  if (logBuffer.length === 0) return;
  try {
    insertLogBatch(logBuffer);
  } catch (err) {
    console.error("[web] Failed to flush logs to SQLite:", err.message);
  }
  logBuffer = [];
}

function scheduleLogFlush() {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    flushLogs();
  }, LOG_BATCH_FLUSH_MS);
}

function addLogEntry(jobId, timestamp, source, message, level = "info") {
  // Check per-job cap
  const count = countLogsByJob.get(jobId);
  if (count && count.count >= MAX_LOGS_PER_JOB) return;

  logBuffer.push({ jobId, timestamp, source, message, level });
  if (logBuffer.length >= LOG_BATCH_FLUSH_LINES) {
    flushLogs();
  } else {
    scheduleLogFlush();
  }
}

// --- SSE event buffer ---
let eventIdCounter = 0;
const eventBuffer = [];

function bufferEvent(event) {
  eventIdCounter++;
  const entry = { id: eventIdCounter, ...event };
  eventBuffer.push(entry);
  if (eventBuffer.length > EVENT_BUFFER_SIZE) {
    eventBuffer.shift();
  }
  return entry;
}

// --- SSE connections ---
const sseClients = new Map();

function broadcastSSE(entry) {
  const data = JSON.stringify(entry);
  for (const [id, res] of sseClients) {
    try {
      res.write(`event: ${entry.type}\nid: ${entry.id}\ndata: ${data}\n\n`);
    } catch (_) {
      sseClients.delete(id);
    }
  }
}

// --- Listen to agent events and persist + broadcast ---
agentEvents.on("job:start", (data) => {
  const result = insertJob.run(data.ticketId, data.type, "running", data.ts || new Date().toISOString(), data.user || "slack");
  activeJobIds.set(data.ticketId, result.lastInsertRowid);
  broadcastSSE(bufferEvent({ type: "job:start", ...data }));
});

agentEvents.on("job:step", (data) => {
  broadcastSSE(bufferEvent({ type: "job:step", ...data }));
});

agentEvents.on("job:log", (data) => {
  const jobId = activeJobIds.get(data.ticketId);
  if (jobId) {
    addLogEntry(jobId, data.ts || new Date().toISOString(), data.source, data.message, data.level || "info");
  }
  broadcastSSE(bufferEvent({ type: "job:log", ...data }));
});

agentEvents.on("job:complete", (data) => {
  const jobId = activeJobIds.get(data.ticketId);
  if (jobId) {
    flushLogs(); // flush any pending logs before marking complete
    updateJobComplete.run(data.outcome || "success", new Date().toISOString(), data.prUrl || null, null, jobId);
    activeJobIds.delete(data.ticketId);
  }
  broadcastSSE(bufferEvent({ type: "job:complete", ...data }));
});

agentEvents.on("job:error", (data) => {
  const jobId = activeJobIds.get(data.ticketId);
  if (jobId) {
    flushLogs();
    updateJobComplete.run("failed", new Date().toISOString(), null, data.error, jobId);
    activeJobIds.delete(data.ticketId);
  }
  broadcastSSE(bufferEvent({ type: "job:error", ...data }));
});

agentEvents.on("queue:update", (data) => {
  broadcastSSE(bufferEvent({ type: "queue:update", ...data }));
});

agentEvents.on("approval:pending", (data) => {
  broadcastSSE(bufferEvent({ type: "approval:pending", ...data }));
});

agentEvents.on("approval:resolved", (data) => {
  broadcastSSE(bufferEvent({ type: "approval:resolved", ...data }));
});

// --- Express app ---
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Health
app.get("/api/health", (req, res) => {
  try {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      version: require("./package.json").version || "1.0.0",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status
app.get("/api/status", (req, res) => {
  try {
    const status = getStatus();
    res.json(status || { activeJob: null, queue: 0, pendingApprovals: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// History (paginated)
app.get("/api/history", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const offset = parseInt(req.query.offset || "0", 10);
    const jobs = getJobHistory.all(limit, offset);
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// History detail
app.get("/api/history/:ticketId", (req, res) => {
  try {
    const job = getJobByTicket.get(req.params.ticketId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const logs = getJobLogs.all(job.id, MAX_LOGS_PER_JOB);
    res.json({ ...job, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SSE endpoint
let sseClientIdCounter = 0;

app.get("/events", (req, res) => {
  // Connection cap
  if (sseClients.size >= MAX_SSE_CONNECTIONS) {
    return res.status(503).json({ error: "Too many SSE connections" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const clientId = ++sseClientIdCounter;
  sseClients.set(clientId, res);

  // Replay buffered events if Last-Event-Id provided
  const lastId = parseInt(req.headers["last-event-id"] || "0", 10);
  if (lastId > 0) {
    const oldestBuffered = eventBuffer.length > 0 ? eventBuffer[0].id : Infinity;
    if (lastId < oldestBuffered) {
      // Client missed more events than buffer holds — send reset
      res.write(`event: reset\ndata: {}\n\n`);
    } else {
      // Replay events after lastId
      for (const entry of eventBuffer) {
        if (entry.id > lastId) {
          const data = JSON.stringify(entry);
          res.write(`event: ${entry.type}\nid: ${entry.id}\ndata: ${data}\n\n`);
        }
      }
    }
  }

  // Heartbeat
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch (_) { clearInterval(heartbeat); }
  }, SSE_HEARTBEAT_MS);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(clientId);
  });
});

// --- Start server ---
const server = app.listen(WEB_PORT, () => {
  console.log(`[web] Dashboard running at http://localhost:${WEB_PORT}`);
});

// --- Graceful shutdown ---
function shutdown() {
  flushLogs();
  server.close();
  db.close();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = { app, db, shutdown, flushLogs, addLogEntry, activeJobIds };
