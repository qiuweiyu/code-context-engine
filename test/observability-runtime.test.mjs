import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openTelemetryStore } from "../src/observability/store.js";
import { startObservabilityApi } from "../src/observability/api.js";
import { createRequestRecorder } from "../src/observability/record.js";
import { repositoryId, taskFingerprint } from "../src/observability/contract.js";
import { serializeQueryOutput } from "../src/context/query-output.js";
import { queryContext } from "../src/context/retriever.js";

const exec = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-trace-"));
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, "src", "tool.js"),
    "export function sampleTool() { return 42; }\n");
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"], ["add", "."], ["commit", "-qm", "init"]]) {
    await exec("git", ["-C", repo, ...args], { windowsHide: true });
  }
  const env = { ...process.env, XDG_STATE_HOME: state, LOCALAPPDATA: state,
    CCE_ALLOWED_ROOTS: repo };
  const storeOptions = { directory: path.join(state, "cce", "telemetry") };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, repo, env, storeOptions };
}
async function cli(env, ...args) {
  const { stdout } = await exec(process.execPath,
    [path.join(sourceRoot, "src/cli.js"), ...args], {
      env, cwd: sourceRoot, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
  return JSON.parse(stdout);
}
function events(request) { return request.events.map((event) => event.event_type); }

test("real CLI index, status and query produce private correlated traces readable by API", async (t) => {
  const { repo, env, storeOptions } = await fixture(t);
  const indexed = await cli(env, "index", "--repo", repo);
  assert.equal(indexed.ok, true);
  const status = await cli(env, "status", "--repo", repo);
  assert.equal(status.stale, false);
  const privateTask = "sampleTool PRIVATE_TASK_MARKER_73492";
  const result = await cli(env, "query", "--repo", repo, "--task", privateTask, "--compact");
  assert.equal(result.ok, true);
  const store = openTelemetryStore(storeOptions);
  const api = await startObservabilityApi({ port: 0, store });
  try {
    const list = store.listRequests().requests;
    assert.deepEqual(list.map((r) => r.operation), ["query", "status", "index"]);
    assert.deepEqual(list.map((r) => r.status), ["success","success","success"]);
    const query = store.getRequest(list[0].request_id);
    assert.deepEqual(events(query), [
      "request_started","query_expanded","candidates_retrieved",
      "graph_expanded","context_selected","query_completed","request_completed"
    ]);
    for (const event of query.events) {
      assert.equal(event.request_id, query.request_id);
      assert.equal(event.trace_id, query.trace_id);
      assert.equal(event.repository_id, repositoryId(repo));
      assert.equal(event.client.transport, "cli");
      assert.equal(event.client.identity, "unavailable");
    }
    assert.equal(query.events[0].payload.task_fingerprint, taskFingerprint(privateTask));
    const done = query.events.at(-2).payload;
    assert.equal(done.full_bytes, Buffer.byteLength(
      serializeQueryOutput(queryContext({ repoRoot: repo, task: privateTask })), "utf8"));
    assert.equal(done.compact_bytes, Buffer.byteLength(JSON.stringify(result), "utf8"));
    assert.equal(done.estimated_full_tokens, null);
    assert.equal(done.measurement_source, "measured");
    assert.equal(done.index_freshness, "unavailable");
    assert.equal(done.reindexed, "no");
    assert.equal(store.getRequest(list[1].request_id).events[1].payload.freshness, "fresh");
    assert.equal(store.getRequest(list[2].request_id).events[1].event_type, "index_started");
    const statusApi = await (await fetch(api.url + "/status")).json();
    assert.equal(statusApi.telemetry.capture, "observed");
    assert.equal(statusApi.client_identity, "unavailable");
    const detail = await (await fetch(api.url + "/requests/" + query.request_id)).json();
    assert.equal(detail.request.events.length, 7);
    assert.deepEqual(detail.effects[0], {
      measurement_source: "measured", scope: "cce_output",
      full_bytes: done.full_bytes, compact_bytes: done.compact_bytes
    });
    assert.deepEqual(detail.effects[1], {
      measurement_source: "estimated", scope: "cce_output",
      method: "utf8_bytes_div_4_v1",
      full_tokens: Math.ceil(done.full_bytes / 4),
      compact_tokens: Math.ceil(done.compact_bytes / 4)
    });
    const effects = await (await fetch(api.url + "/effects")).json();
    assert.equal(effects.query_counts.measured, 1);
    assert.deepEqual(effects.measurements, detail.effects);
    assert.equal(effects.controlled_experiment.status, "unavailable");
    const json = JSON.stringify(detail);
    assert.equal(json.includes(privateTask), false);
    assert.equal(json.includes(repo), false);
    assert.equal(json.includes("src/tool.js"), false);
    const raw = await fs.readFile(store.dbPath);
    assert.equal(raw.includes(Buffer.from(privateTask)), false);
    assert.equal(raw.includes(Buffer.from("sampleTool() { return 42")), false);
  } finally { await api.close(); store.close(); }
});

test("MCP transport is recorded without inventing client identity; failure keeps native result", async (t) => {
  const { repo, env, storeOptions } = await fixture(t);
  await cli(env, "index", "--repo", repo);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(sourceRoot, "src/server.js")],
    env, stderr: "pipe"
  });
  const client = new Client({ name: "fake-named-client", version: "1.0.0" },
    { capabilities: {} });
  try {
    await client.connect(transport);
    const query = await client.callTool({ name: "context_query",
      arguments: { repo_root: repo, task: "sampleTool", compact: true } });
    assert.equal(JSON.parse(query.content[0].text).ok, true);
    const refreshed = await client.callTool({ name: "context_index_repo",
      arguments: { repo_root: repo } });
    assert.equal(JSON.parse(refreshed.content[0].text).ok, true);
    const checked = await client.callTool({ name: "context_index_status",
      arguments: { repo_root: repo } });
    assert.equal(JSON.parse(checked.content[0].text).ok, true);
    const failed = await client.callTool({ name: "context_query",
      arguments: { repo_root: path.dirname(repo), task: "sampleTool" } });
    assert.equal(JSON.parse(failed.content[0].text).ok, false);
  } finally { await client.close(); }
  const store = openTelemetryStore(storeOptions);
  try {
    const list = store.listRequests().requests;
    assert.deepEqual(list.slice(0, 4).map((r) => r.status),
      ["failure", "success", "success", "success"]);
    assert.deepEqual(list.slice(0, 4).map((r) => r.client_transport),
      ["mcp", "mcp", "mcp", "mcp"]);
    assert.equal(store.getRequest(list[2].request_id).events[1].event_type, "index_started");
    assert.deepEqual(events(store.getRequest(list[0].request_id)), [
      "request_started","query_failed","request_completed"
    ]);
    assert.equal(store.getRequest(list[0].request_id).events.at(-1).payload.error_code,
      "invalid_input");
    assert.equal(JSON.stringify(store.getRequest(list[3].request_id)).includes("fake-named-client"), false);
  } finally { store.close(); }
});

test("recorder never changes operation success/failure when telemetry fails; fallback remains success", async () => {
  const recorder = createRequestRecorder({
    transport: "cli", storeFactory: () => { throw new Error("telemetry unavailable"); }
  });
  const ok = { ok: true };
  assert.equal(await recorder.run({ operation: "status", repoRoot: "/repo",
    execute: () => ok }), ok);
  const expected = new Error("underlying failure");
  await assert.rejects(recorder.run({ operation: "index", repoRoot: "/repo",
    execute: () => { throw expected; } }), (error) => error === expected);
  const saved = [];
  const second = createRequestRecorder({ transport: "mcp", storeFactory: () => ({
    appendEvent: (event) => saved.push(event), close() {}
  }) });
  await second.run({ operation: "query", repoRoot: "/repo", task: "sample",
    execute: () => ({ ok: true, query_expansion: { applied_aliases: [] },
      must_read: [], maybe_read: [], tests: [], semantic_refinement: { status: "fallback" } })
  });
  assert.equal(saved.find((e) => e.event_type === "query_completed").payload.semantic_fallback, true);
  assert.equal(saved.at(-1).payload.status, "success");
  second.close();
});
