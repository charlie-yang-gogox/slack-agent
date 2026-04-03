import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";

// We need to test web.js in isolation without agent.js (which requires Slack tokens).
// Strategy: import web.js directly (it self-starts Express) then test the endpoints.

let app, db, shutdown, flushLogs, addLogEntry, activeJobIds;
let server;
let baseUrl;

beforeAll(async () => {
  // Set a random port to avoid conflicts
  const port = 30000 + Math.floor(Math.random() * 10000);
  process.env.WEB_PORT = String(port);
  baseUrl = `http://localhost:${port}`;

  // Import web.js — it starts Express automatically
  const web = await import("../web.js");
  app = web.app;
  db = web.db;
  shutdown = web.shutdown;
  flushLogs = web.flushLogs;
  addLogEntry = web.addLogEntry;
  activeJobIds = web.activeJobIds;

  // Wait for server to be ready
  await new Promise((resolve) => setTimeout(resolve, 200));
});

afterAll(() => {
  if (shutdown) shutdown();
});

// Helper: fetch JSON from the test server
async function fetchJSON(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

describe("GET /api/health", () => {
  it("returns ok status with uptime", async () => {
    const { status, body } = await fetchJSON("/api/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThan(0);
  });
});

describe("GET /api/status", () => {
  it("returns default state when idle", async () => {
    const { status, body } = await fetchJSON("/api/status");
    expect(status).toBe(200);
    expect(body).toHaveProperty("activeJob");
  });
});

describe("GET /api/history", () => {
  it("returns empty array initially", async () => {
    const { status, body } = await fetchJSON("/api/history");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns jobs after inserting via SQLite", async () => {
    db.prepare(
      "INSERT INTO jobs (ticketId, type, status, startedAt, triggeredBy) VALUES (?, ?, ?, ?, ?)"
    ).run("TEST-001", "dev", "success", new Date().toISOString(), "test");

    const { status, body } = await fetchJSON("/api/history");
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].ticketId).toBe("TEST-001");
  });

  it("respects pagination params", async () => {
    const { status, body } = await fetchJSON("/api/history?limit=1&offset=0");
    expect(status).toBe(200);
    expect(body.length).toBeLessThanOrEqual(1);
  });
});

describe("GET /api/history/:ticketId", () => {
  it("returns 404 for nonexistent ticket", async () => {
    const { status, body } = await fetchJSON("/api/history/NONEXISTENT-999");
    expect(status).toBe(404);
    expect(body.error).toBe("Job not found");
  });

  it("returns job with logs for existing ticket", async () => {
    // Insert a job and some logs
    const result = db.prepare(
      "INSERT INTO jobs (ticketId, type, status, startedAt, triggeredBy) VALUES (?, ?, ?, ?, ?)"
    ).run("TEST-002", "ff", "running", new Date().toISOString(), "test");
    const jobId = result.lastInsertRowid;

    db.prepare(
      "INSERT INTO logs (jobId, timestamp, source, message, level) VALUES (?, ?, ?, ?, ?)"
    ).run(jobId, new Date().toISOString(), "stdout", "test log line", "info");

    const { status, body } = await fetchJSON("/api/history/TEST-002");
    expect(status).toBe(200);
    expect(body.ticketId).toBe("TEST-002");
    expect(body.logs.length).toBe(1);
    expect(body.logs[0].message).toBe("test log line");
  });
});

describe("GET /events (SSE)", () => {
  it("sets correct SSE headers", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      const res = await fetch(`${baseUrl}/events`, { signal: controller.signal });
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      controller.abort();
    } catch (e) {
      // AbortError is expected
      if (e.name !== "AbortError") throw e;
    } finally {
      clearTimeout(timeout);
    }
  });
});

describe("SQLite", () => {
  it("creates tables on startup", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toContain("jobs");
    expect(tables).toContain("logs");
  });
});

describe("Log batching", () => {
  it("flushes logs when batch size reached", async () => {
    // Insert a job to reference
    const result = db.prepare(
      "INSERT INTO jobs (ticketId, type, status, startedAt) VALUES (?, ?, ?, ?)"
    ).run("TEST-BATCH", "dev", "running", new Date().toISOString());
    const jobId = result.lastInsertRowid;

    // Add 50 log entries (should trigger flush)
    for (let i = 0; i < 50; i++) {
      addLogEntry(jobId, new Date().toISOString(), "stdout", `line ${i}`);
    }

    // Give a tick for the flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    const count = db.prepare("SELECT COUNT(*) as count FROM logs WHERE jobId = ?").get(jobId);
    expect(count.count).toBe(50);
  });
});

describe("Error handling", () => {
  it("returns 500 JSON for malformed requests (not crash)", async () => {
    // NaN limit causes SQLite error — but Express catches it and returns 500 JSON
    const { status, body } = await fetchJSON("/api/history?limit=abc");
    expect(status).toBe(500);
    expect(body).toHaveProperty("error");
  });
});
