import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { TELEMETRY_SCHEMA_VERSION, createTelemetryEvent } from "./contract.js";

export const TELEMETRY_STORE_VERSION = 1;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_REQUESTS = 5000;
const MAX_EVENTS_PER_REQUEST = 128;
const cursorSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  request_id: z.string().uuid()
}).strict();

export function defaultTelemetryDirectory({
  platform = process.platform, env = process.env, home = os.homedir()
} = {}) {
  const base = platform === "win32"
    ? (env.LOCALAPPDATA || path.join(home, "AppData", "Local"))
    : (env.XDG_STATE_HOME || path.join(home, ".local", "state"));
  return path.join(base, "cce", "telemetry");
}

function positiveInteger(value, name, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

function assertPrivate(file, label) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`${label} cannot be a symlink`);
  if (label === "telemetry directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`${label} has an unexpected type`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077)) {
    throw new Error(`${label} is accessible to other users`);
  }
}

function inTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function initialize(db, preexisting) {
  const metaExists = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='meta'"
  ).get();
  if (preexisting && !metaExists) {
    throw new Error("existing telemetry database has no schema version");
  }
  if (metaExists) {
    const version = Number(db.prepare(
      "SELECT value FROM meta WHERE key='schema_version'"
    ).get()?.value);
    if (version !== TELEMETRY_STORE_VERSION) {
      throw new Error(`unsupported telemetry schema version: ${version}`);
    }
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS requests (
      request_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('query','index','status')),
      client_transport TEXT NOT NULL,
      runtime_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','success','failure')),
      duration_ms REAL,
      completed_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS requests_recent
      ON requests(timestamp DESC, request_id DESC);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS events_by_request ON events(request_id, id);
  `);
  if (!metaExists) db.prepare(
    "INSERT INTO meta(key,value) VALUES ('schema_version',?)"
  ).run(String(TELEMETRY_STORE_VERSION));
}

function pruneInTransaction(db, retentionDays, maxRequests, now) {
  const cutoff = new Date(now.getTime() - retentionDays * 86400000).toISOString();
  const expired = db.prepare(
    "DELETE FROM requests WHERE timestamp < ?"
  ).run(cutoff).changes;
  const overflow = db.prepare(`
    DELETE FROM requests WHERE request_id NOT IN (
      SELECT request_id FROM requests ORDER BY timestamp DESC, request_id DESC LIMIT ?
    )
  `).run(maxRequests).changes;
  return { expired, overflow };
}

export function openTelemetryStore({
  directory = defaultTelemetryDirectory(),
  retentionDays = DEFAULT_RETENTION_DAYS,
  maxRequests = DEFAULT_MAX_REQUESTS,
  now = () => new Date()
} = {}) {
  positiveInteger(retentionDays, "retentionDays", 3650);
  positiveInteger(maxRequests, "maxRequests", 100000);
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const dir = path.resolve(directory);
  assertPrivate(dir, "telemetry directory");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivate(dir, "telemetry directory");
  const dbPath = path.join(dir, "telemetry.sqlite");
  assertPrivate(dbPath, "telemetry database");
  const preexisting = fs.existsSync(dbPath);
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    if (process.platform !== "win32") fs.chmodSync(dbPath, 0o600);
    initialize(db, preexisting);
  } catch (error) {
    db.close();
    throw error;
  }

  let closed = false;
  const active = () => {
    if (closed) throw new Error("telemetry store is closed");
  };
  const prune = () => {
    active();
    const clock = now();
    if (!(clock instanceof Date) || Number.isNaN(clock.getTime())) {
      throw new TypeError("now must return a valid Date");
    }
    return inTransaction(db, () =>
      pruneInTransaction(db, retentionDays, maxRequests, clock));
  };
  const appendEvent = (input) => {
    active();
    const event = createTelemetryEvent(input);
    const timestamp = new Date(event.timestamp).toISOString();
    return inTransaction(db, () => {
      if (event.event_type === "request_started") {
        db.prepare(`
          INSERT INTO requests(
            request_id,trace_id,repository_id,timestamp,operation,
            client_transport,runtime_json
          ) VALUES (?,?,?,?,?,?,?)
        `).run(
          event.request_id, event.trace_id, event.repository_id,
          timestamp, event.payload.operation, event.client.transport,
          JSON.stringify(event.runtime)
        );
      } else {
        const request = db.prepare(
          "SELECT * FROM requests WHERE request_id=?"
        ).get(event.request_id);
        if (!request) throw new Error("request_started must be recorded first");
        if (request.status !== "running") throw new Error("request is already complete");
        if (request.trace_id !== event.trace_id
          || request.repository_id !== event.repository_id
          || request.client_transport !== event.client.transport
          || request.runtime_json !== JSON.stringify(event.runtime)) {
          throw new Error("event does not match request identity");
        }
        if (timestamp < request.timestamp) {
          throw new Error("event precedes request_started");
        }
        const eventCount = db.prepare(
          "SELECT COUNT(*) AS count FROM events WHERE request_id=?"
        ).get(event.request_id).count;
        if (eventCount >= MAX_EVENTS_PER_REQUEST) {
          throw new Error("maximum events per request exceeded");
        }
        if (event.event_type === "request_completed") {
          if (event.payload.operation !== request.operation) {
            throw new Error("completion operation does not match request");
          }
          db.prepare(`
            UPDATE requests SET status=?,duration_ms=?,completed_at=?
            WHERE request_id=?
          `).run(
            event.payload.status, event.payload.duration_ms,
            timestamp, event.request_id
          );
        }
      }
      db.prepare(
        "INSERT INTO events(request_id,event_type,timestamp,event_json) VALUES (?,?,?,?)"
      ).run(event.request_id, event.event_type, timestamp, JSON.stringify(event));
      if (event.event_type === "request_started") {
        const clock = now();
        if (!(clock instanceof Date) || Number.isNaN(clock.getTime())) {
          throw new TypeError("now must return a valid Date");
        }
        pruneInTransaction(db, retentionDays, maxRequests, clock);
      }
      return event;
    });
  };
  const listRequests = ({ limit = 50, before = null } = {}) => {
    active();
    positiveInteger(limit, "limit", 100);
    const cursor = before === null ? null : cursorSchema.parse(before);
    const timestamp = cursor ? new Date(cursor.timestamp).toISOString() : null;
    const rows = cursor
      ? db.prepare(`
          SELECT * FROM requests
          WHERE timestamp < ? OR (timestamp = ? AND request_id < ?)
          ORDER BY timestamp DESC, request_id DESC LIMIT ?
        `).all(timestamp, timestamp, cursor.request_id, limit + 1)
      : db.prepare(`
          SELECT * FROM requests ORDER BY timestamp DESC, request_id DESC LIMIT ?
        `).all(limit + 1);
    const page = rows.slice(0, limit).map(({ runtime_json, ...row }) => ({
      ...row, runtime: JSON.parse(runtime_json)
    }));
    const last = page.at(-1);
    return {
      requests: page,
      next_cursor: rows.length > limit
        ? { timestamp: last.timestamp, request_id: last.request_id }
        : null
    };
  };
  const getRequest = (requestId) => {
    active();
    z.string().uuid().parse(requestId);
    const row = db.prepare(
      "SELECT * FROM requests WHERE request_id=?"
    ).get(requestId);
    if (!row) return null;
    const { runtime_json, ...request } = row;
    const events = db.prepare(
      "SELECT event_json FROM events WHERE request_id=? ORDER BY id"
    ).all(requestId).map(({ event_json }) =>
      createTelemetryEvent(JSON.parse(event_json)));
    return { ...request, runtime: JSON.parse(runtime_json), events };
  };
  const getMetrics = ({ since } = {}) => {
    active();
    if (!(since instanceof Date) || Number.isNaN(since.getTime())) {
      throw new TypeError("since must be a valid Date");
    }
    const windowStart = since.toISOString();
    const allTime = db.prepare(
      "SELECT COUNT(*) AS requests FROM requests"
    ).get().requests;
    const window = db.prepare(`
      SELECT COUNT(*) AS requests,
        SUM(CASE WHEN operation='query' THEN 1 ELSE 0 END) AS queries,
        SUM(CASE WHEN status='failure' THEN 1 ELSE 0 END) AS failures,
        AVG(CASE WHEN operation='query' AND status='success'
          THEN duration_ms END) AS average_query_duration_ms,
        MAX(timestamp) AS last_request_at
      FROM requests WHERE timestamp >= ?
    `).get(windowStart);
    return {
      window_since: windowStart,
      requests_all_time: allTime,
      requests: window.requests,
      queries: window.queries ?? 0,
      failures: window.failures ?? 0,
      average_query_duration_ms: window.average_query_duration_ms,
      last_request_at: window.last_request_at
    };
  };
  return {
    dbPath, appendEvent, listRequests, getRequest, getMetrics, prune,
    close() { if (!closed) { db.close(); closed = true; } }
  };
}
