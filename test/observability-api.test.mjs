import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startObservabilityApi } from "../src/observability/api.js";
import { openTelemetryStore } from "../src/observability/store.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = "a".repeat(64);
const clock = () => new Date("2026-09-28T14:00:00Z");
const envelope = (n, timestamp = "2026-09-28T13:00:00Z") => ({
  schema_version: 1, request_id: id(n), trace_id: id(n + 100),
  timestamp, repository_id: digest,
  client: { transport: "mcp", identity: "unavailable" },
  runtime: { package_version: "0.2.0", git_head: null, fingerprint: digest }
});
function seed(store, n, status = "success", duration = 4.5) {
  store.appendEvent({
    ...envelope(n), event_type: "request_started",
    payload: {
      operation: "query", query_capture: "unavailable", task_fingerprint: digest
    }
  });
  store.appendEvent({
    ...envelope(n), event_type: "request_completed",
    payload: {
      operation: "query", duration_ms: duration, status,
      error_code: status === "success" ? "none" : "query_error"
    }
  });
}
async function fixture(t, useOwnedStore = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cce-api-test-"));
  const directory = path.join(root, "telemetry");
  const store = useOwnedStore ? null : openTelemetryStore({
    directory, now: clock
  });
  const api = await startObservabilityApi({
    port: 0, directory, store, clock
  });
  t.after(async () => {
    await api.close();
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { api, store, directory };
}
async function get(url) {
  const response = await fetch(url);
  return { response, body: await response.json() };
}
function request(url, { method = "GET", host, origin } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port,
      path: parsed.pathname + parsed.search, method,
      headers: {
        ...(host ? { Host: host } : {}),
        ...(origin ? { Origin: origin } : {})
      }
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("empty local API is honest about inactive capture and unavailable effects", async (t) => {
  const { api } = await fixture(t, true);
  assert.match(api.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const status = await get(api.url + "/status");
  assert.equal(status.response.status, 200);
  assert.equal(status.body.state, "online");
  assert.equal(status.body.telemetry.capture, "inactive");
  assert.equal(status.body.index_freshness, "unavailable");
  assert.equal(status.body.active_repository, null);
  assert.equal("runtime_root" in status.body.runtime, false);
  assert.equal(status.response.headers.get("cache-control"), "no-store");
  assert.equal(status.response.headers.get("access-control-allow-origin"), null);
  const requests = await get(api.url + "/requests");
  assert.deepEqual(requests.body, { ok: true, requests: [], next_cursor: null });
  const metrics = await get(api.url + "/metrics");
  assert.equal(metrics.body.requests, 0);
  assert.equal(metrics.body.average_query_duration_ms, null);
  assert.equal(metrics.body.window, "last_24h");
  const effects = await get(api.url + "/effects");
  assert.deepEqual(effects.body, {
    ok: true, status: "unavailable",
    reason: "measurement_not_implemented", measurements: []
  });
});

test("requests pagination, detail and observed metrics use real stored events", async (t) => {
  const { api, store, directory } = await fixture(t);
  seed(store, 1, "success", 10);
  seed(store, 2, "failure", 5);
  seed(store, 3, "success", 20);
  const first = await get(api.url + "/requests?limit=2");
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.body.requests.map((r) => r.request_id), [id(3), id(2)]);
  assert.ok(first.body.next_cursor);
  const second = await get(api.url + "/requests?limit=2&cursor=" + first.body.next_cursor);
  assert.deepEqual(second.body.requests.map((r) => r.request_id), [id(1)]);
  assert.equal(second.body.next_cursor, null);
  const detail = await get(api.url + "/requests/" + id(1));
  assert.deepEqual(detail.body.request.events.map((event) => event.event_type), [
    "request_started", "request_completed"
  ]);
  const metrics = await get(api.url + "/metrics");
  assert.equal(metrics.body.requests_all_time, 3);
  assert.equal(metrics.body.requests, 3);
  assert.equal(metrics.body.queries, 3);
  assert.equal(metrics.body.failures, 1);
  assert.equal(metrics.body.average_query_duration_ms, 15);
  assert.equal(JSON.stringify(detail.body).includes(directory), false);
  assert.equal(JSON.stringify(detail.body).includes("source_body"), false);
});

test("route and input validation do not disclose internals", async (t) => {
  const { api } = await fixture(t);
  for (const route of [
    "/requests?limit=0", "/requests?limit=101",
    "/requests?limit=1&limit=2", "/requests?cursor=###",
    "/requests/" + id(1) + "?extra=1", "/metrics?repo=/tmp",
    "/status?x=1", "/effects?x=1"
  ]) {
    const { response, body } = await get(api.url + route);
    assert.equal(response.status, 400, route);
    assert.equal(body.error, "invalid_request");
  }
  assert.equal((await get(api.url + "/requests/not-a-uuid")).response.status, 400);
  assert.equal((await get(api.url + "/requests/" + id(9))).response.status, 404);
  assert.equal((await get(api.url + "/unknown")).response.status, 404);
});

test("foreign Host and Origin, writes and public bind are refused", async (t) => {
  const { api } = await fixture(t);
  assert.equal((await request(api.url + "/status", { host: "evil.example" })).status, 403);
  assert.equal((await request(api.url + "/status", { origin: "https://evil.example" })).status, 403);
  assert.equal((await request(api.url + "/status", { method: "POST" })).status, 405);
  assert.equal((await request(api.url + "/status", { origin: api.url })).status, 200);
  await assert.rejects(
    startObservabilityApi({ host: "0.0.0.0", port: 0 }),
    /only binds 127.0.0.1/
  );
  await assert.rejects(
    startObservabilityApi({ host: "127.0.0.1", port: -1 }),
    /port must/
  );
});

test("API closes owned storage and releases the listening socket", async (t) => {
  const { api, directory } = await fixture(t, true);
  assert.equal(fs.existsSync(path.join(directory, "telemetry.sqlite")), true);
  await api.close();
  await api.close();
  await assert.rejects(fetch(api.url + "/status"));
});

test("UI assets are same-origin, allowlisted and protected by a restrictive CSP", async (t) => {
  const { api } = await fixture(t);
  const html = await fetch(api.url + "/");
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /text\/html/);
  assert.match(html.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(html.headers.get("cache-control"), "no-store");
  const markup = await html.text();
  for (const page of ["overview", "requests", "effects", "settings"]) {
    assert.match(markup, new RegExp(`data-view="${page}"`));
  }
  assert.equal(markup.includes("https://"), false);
  for (const [path, type] of [["/app.js", "text/javascript"], ["/styles.css", "text/css"], ["/favicon.svg", "image/svg+xml"]]) {
    const response = await fetch(api.url + path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get("content-type").includes(type));
    assert.ok((await response.text()).length > 100);
  }
  assert.equal((await get(api.url + "/../package.json")).response.status, 404);
  assert.equal((await get(api.url + "/ui/app.js")).response.status, 404);
  assert.equal((await get(api.url + "/?unrecognized=1")).response.status, 400);
  assert.equal((await request(api.url + "/", { host: "evil.example" })).status, 403);
});

test("status exposes actual retention settings without exposing the database path", async (t) => {
  const { api, directory } = await fixture(t);
  const { body } = await get(api.url + "/status");
  assert.equal(body.telemetry.retention_days, 30);
  assert.equal(body.telemetry.max_requests, 5000);
  assert.equal(body.listen.host, "127.0.0.1");
  assert.equal(JSON.stringify(body).includes(directory), false);
});
