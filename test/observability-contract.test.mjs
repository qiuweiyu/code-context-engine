import test from "node:test";
import assert from "node:assert/strict";
import {
  TELEMETRY_SCHEMA_VERSION, eventTypes, measurementSources, telemetryEventSchema,
  effectSchema, createTelemetryEvent, createOutputEffect, repositoryId, taskFingerprint
} from "../src/observability/contract.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);
const base = {
  schema_version: TELEMETRY_SCHEMA_VERSION,
  trace_id: uuid, request_id: uuid,
  timestamp: "2026-09-28T12:00:00.000Z",
  repository_id: digest,
  client: { transport: "mcp", identity: "unavailable" },
  runtime: { package_version: "0.2.0", git_head: null, fingerprint: digest }
};
const completion = {
  duration_ms: 4.5, status: "success",
  index_freshness: "unavailable", reindexed: "unavailable",
  must_read_count: 2, maybe_read_count: 1, test_count: 1,
  full_bytes: 104, compact_bytes: 52,
  estimated_full_tokens: null, estimated_compact_tokens: null,
  token_estimation_method: "unavailable"
};

test("event vocabulary and measurement sources are versioned", () => {
  assert.equal(eventTypes.length, 11);
  assert.deepEqual(measurementSources, [
    "measured", "estimated", "controlled_experiment"
  ]);
  const event = createTelemetryEvent({
    ...base, event_type: "query_completed", payload: completion
  });
  assert.equal(JSON.stringify(event), JSON.stringify(
    createTelemetryEvent({ ...base, event_type: "query_completed", payload: completion })
  ));
  assert.equal(telemetryEventSchema.parse(event).schema_version, 1);
});

test("default trace cannot capture source, task, errors, or arbitrary fields", () => {
  const started = {
    ...base, event_type: "request_started",
    payload: { operation: "query", query_capture: "unavailable", task_fingerprint: digest }
  };
  assert.deepEqual(createTelemetryEvent(started), started);
  assert.throws(() => createTelemetryEvent({
    ...started, source_body: "private key"
  }));
  assert.throws(() => createTelemetryEvent({
    ...started, payload: { ...started.payload, task: "secret" }
  }));
  assert.throws(() => createTelemetryEvent({
    ...started, payload: { ...started.payload, query_capture: "stored" }
  }));
  assert.throws(() => createTelemetryEvent({
    ...base, event_type: "query_failed",
    payload: {
      duration_ms: 1, status: "failure",
      index_freshness: "unavailable", error_code: "query_error",
      message: "API_KEY=secret"
    }
  }));
  assert.throws(() => createTelemetryEvent({
    ...started, client: { transport: "mcp", identity: "codex_desktop" }
  }));
});

test("invalid measurements and invented experiment labels are rejected", () => {
  const valid = { ...base, event_type: "query_completed", payload: completion };
  assert.throws(() => createTelemetryEvent({
    ...valid, payload: { ...completion, duration_ms: -1 }
  }));
  assert.throws(() => createTelemetryEvent({
    ...valid, payload: { ...completion, estimated_full_tokens: 26 }
  }));
  assert.throws(() => effectSchema.parse({
    measurement_source: "controlled_experiment",
    scope: "agent_workflow", experiment_id: uuid,
    without_cce_tokens: 10, with_cce_tokens: 5,
    same_task_and_agent: false
  }));
  assert.throws(() => effectSchema.parse({
    measurement_source: "measured", scope: "cce_output",
    full_bytes: 10, compact_bytes: 5, source_body: "secret"
  }));
});

test("UTF-8 exact output bytes and opaque repository identity", () => {
  assert.deepEqual(createOutputEffect({ full: "苹果", compact: "A" }), {
    measurement_source: "measured", scope: "cce_output",
    full_bytes: 6, compact_bytes: 1
  });
  assert.equal(taskFingerprint("版本").length, 64);
  assert.equal(repositoryId("C:\\repo").length, 64);
  assert.equal(repositoryId("/tmp/repo"), repositoryId("/tmp/repo"));
  assert.notEqual(repositoryId("C:\\repo"), repositoryId("/tmp/repo"));
  assert.throws(() => repositoryId(""));
});

test("status and error codes agree for completed requests", () => {
  const payload = { operation: "query", duration_ms: 0, status: "success", error_code: "none" };
  assert.equal(createTelemetryEvent({ ...base, event_type: "request_completed", payload }).payload.status, "success");
  assert.throws(() => createTelemetryEvent({ ...base, event_type: "request_completed", payload: { ...payload, error_code: "query_error" } }));
});
