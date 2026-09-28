import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TELEMETRY_STORE_VERSION, defaultTelemetryDirectory, openTelemetryStore
} from "../src/observability/store.js";

const digest = "b".repeat(64);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clock = () => new Date("2026-09-28T12:00:00Z");
const envelope = (n, timestamp = "2026-09-28T11:00:00Z") => ({
  schema_version: 1, trace_id: uuid(n + 1000),
  request_id: uuid(n), timestamp, repository_id: digest,
  client: { transport: "cli", identity: "unavailable" },
  runtime: { package_version: "0.2.0", git_head: null, fingerprint: digest }
});
const start = (n, time) => ({
  ...envelope(n, time), event_type: "request_started",
  payload: {
    operation: "query", query_capture: "unavailable", task_fingerprint: digest
  }
});
const selected = (n, time) => ({
  ...envelope(n, time), event_type: "context_selected",
  payload: { must_read_count: 2, maybe_read_count: 1, test_count: 1 }
});
const finish = (n, time) => ({
  ...envelope(n, time), event_type: "request_completed",
  payload: {
    operation: "query", status: "success", duration_ms: 5.5, error_code: "none"
  }
});

async function fixture(t, options = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cce-telemetry-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { directory: path.join(parent, "telemetry"), now: clock, ...options };
}

test("default storage path is separate from repository/index on Linux and Windows", () => {
  assert.equal(defaultTelemetryDirectory({
    platform: "linux", env: { XDG_STATE_HOME: "/state" }, home: "/home/user"
  }), path.join("/state", "cce", "telemetry"));
  assert.equal(defaultTelemetryDirectory({
    platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\Me\\AppData\\Local" },
    home: "C:\\Users\\Me"
  }), path.join("C:\\Users\\Me\\AppData\\Local", "cce", "telemetry"));
  assert.equal(TELEMETRY_STORE_VERSION, 1);
});

test("append, reopen, list and detail preserve validated event order", async (t) => {
  const options = await fixture(t);
  const store = openTelemetryStore(options);
  try {
    store.appendEvent(start(1));
    store.appendEvent(selected(1));
    store.appendEvent(finish(1));
    assert.equal(store.getRequest(uuid(1)).status, "success");
    assert.equal(store.getRequest(uuid(1)).duration_ms, 5.5);
    assert.deepEqual(store.getRequest(uuid(1)).events.map((e) => e.event_type), [
      "request_started", "context_selected", "request_completed"
    ]);
    assert.equal(store.listRequests().requests[0].runtime.package_version, "0.2.0");
    assert.equal(store.listRequests().next_cursor, null);
    assert.equal(store.getRequest(uuid(2)), null);
    assert.equal(store.dbPath, path.join(options.directory, "telemetry.sqlite"));
    assert.equal(store.dbPath.includes(".context-index"), false);
  } finally { store.close(); }
  const again = openTelemetryStore(options);
  try {
    assert.equal(again.getRequest(uuid(1)).events.length, 3);
    assert.throws(() => again.appendEvent(start(1)));
  } finally { again.close(); }
  assert.throws(() => again.listRequests(), /closed/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(options.directory).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(options.directory, "telemetry.sqlite")).mode & 0o077, 0);
  }
});

test("bounded keyset pagination is stable for timestamp ties", async (t) => {
  const options = await fixture(t);
  const store = openTelemetryStore(options);
  try {
    for (let n = 1; n <= 5; n++) store.appendEvent(start(n));
    const first = store.listRequests({ limit: 2 });
    assert.deepEqual(first.requests.map((r) => r.request_id), [uuid(5), uuid(4)]);
    const second = store.listRequests({ limit: 2, before: first.next_cursor });
    const third = store.listRequests({ limit: 2, before: second.next_cursor });
    assert.deepEqual([
      ...first.requests, ...second.requests, ...third.requests
    ].map((r) => r.request_id), [5,4,3,2,1].map(uuid));
    assert.equal(third.next_cursor, null);
    assert.throws(() => store.listRequests({ limit: 101 }));
    assert.throws(() => store.listRequests({ before: { timestamp: "bad", request_id: uuid(3) } }));
  } finally { store.close(); }
});

test("age and maximum count retention cascade to events", async (t) => {
  const options = await fixture(t, { retentionDays: 2, maxRequests: 2 });
  const store = openTelemetryStore(options);
  try {
    store.appendEvent(start(1, "2026-09-20T00:00:00Z"));
    assert.equal(store.getRequest(uuid(1)), null);
    store.appendEvent(start(2));
    store.appendEvent(selected(2));
    store.appendEvent(start(3));
    store.appendEvent(start(4));
    assert.equal(store.getRequest(uuid(2)), null);
    assert.deepEqual(store.listRequests().requests.map((r) => r.request_id), [
      uuid(4), uuid(3)
    ]);
    const db = new DatabaseSync(store.dbPath);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM requests").get().n, 2);
    } finally { db.close(); }
    assert.deepEqual(store.prune(), { expired: 0, overflow: 0 });
  } finally { store.close(); }
});

test("privacy and identity validation rollback without partial rows", async (t) => {
  const options = await fixture(t);
  const store = openTelemetryStore(options);
  try {
    assert.throws(() => store.appendEvent(selected(1)), /request_started/);
    assert.throws(() => store.appendEvent({
      ...start(1), payload: { ...start(1).payload, source_body: "secret" }
    }));
    assert.equal(store.listRequests().requests.length, 0);
    store.appendEvent(start(1));
    assert.throws(() => store.appendEvent({
      ...selected(1), repository_id: "a".repeat(64)
    }), /identity/);
    assert.throws(() => store.appendEvent({
      ...selected(1), timestamp: "2026-09-28T10:00:00Z"
    }), /precedes/);
    assert.throws(() => store.appendEvent({
      ...finish(1), payload: { ...finish(1).payload, operation: "index" }
    }), /operation/);
    assert.equal(store.getRequest(uuid(1)).events.length, 1);
    store.appendEvent(finish(1));
    assert.throws(() => store.appendEvent(selected(1)), /already complete/);
  } finally { store.close(); }
});

test("unknown database schema and permissive directory are rejected", async (t) => {
  const options = await fixture(t);
  fs.mkdirSync(options.directory, { mode: 0o700 });
  const pathToDb = path.join(options.directory, "telemetry.sqlite");
  const db = new DatabaseSync(pathToDb);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','999')");
  db.close();
  if (process.platform !== "win32") fs.chmodSync(pathToDb, 0o600);
  assert.throws(() => openTelemetryStore(options), /unsupported telemetry schema/);
  if (process.platform !== "win32") {
    fs.chmodSync(options.directory, 0o755);
    assert.throws(() => openTelemetryStore(options), /accessible to other users/);
  }
});

test("invalid retention configuration is rejected before storage creation", async (t) => {
  const options = await fixture(t);
  assert.throws(() => openTelemetryStore({ ...options, retentionDays: 0 }), RangeError);
  assert.throws(() => openTelemetryStore({ ...options, maxRequests: -1 }), RangeError);
  assert.equal(fs.existsSync(options.directory), false);
});

test("two local connections share committed events without changing the index", async (t) => {
  const options = await fixture(t);
  const first = openTelemetryStore(options);
  const second = openTelemetryStore(options);
  try {
    first.appendEvent(start(1));
    assert.equal(second.getRequest(uuid(1)).events.length, 1);
    second.appendEvent(selected(1));
    assert.equal(first.getRequest(uuid(1)).events.length, 2);
    second.appendEvent(finish(1));
    assert.equal(first.listRequests().requests[0].status, "success");
    assert.equal(fs.existsSync(path.join(options.directory, "index.sqlite")), false);
  } finally { first.close(); second.close(); }
});

test("effect totals respect request retention rather than claiming lifetime savings", async (t) => {
  const options = await fixture(t, { maxRequests: 2 });
  const store = openTelemetryStore(options);
  try {
    for (let n = 1; n <= 3; n++) {
      store.appendEvent(start(n));
      store.appendEvent({
        ...envelope(n), event_type: "query_completed",
        payload: {
          duration_ms: 1, status: "success", index_freshness: "unavailable",
          reindexed: "no", must_read_count: 0, maybe_read_count: 0,
          test_count: 0, full_bytes: n * 4, compact_bytes: n,
          estimated_full_tokens: null, estimated_compact_tokens: null,
          token_estimation_method: "unavailable", measurement_source: "measured"
        }
      });
      store.appendEvent(finish(n));
    }
    assert.equal(store.getRequest(uuid(1)), null);
    assert.deepEqual(store.getEffects().query_counts,
      { successful: 2, measured: 2, unmeasured: 0 });
    assert.deepEqual(store.getEffects().measurements[0], {
      measurement_source: "measured", scope: "cce_output",
      full_bytes: 20, compact_bytes: 5
    });
  } finally { store.close(); }
});
