import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

// v1 describes facts observed by CCE, not inferred agent behavior.
export const TELEMETRY_SCHEMA_VERSION = 1;
export const measurementSources = ["measured", "estimated", "controlled_experiment"];
export const eventTypes = [
  "request_started", "request_completed", "index_status_checked", "index_started", "index_completed",
  "query_expanded", "candidates_retrieved", "graph_expanded", "context_selected",
  "query_completed", "query_failed"
];

const count = z.number().int().nonnegative();
const duration = z.number().finite().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const client = z.object({
  transport: z.enum(["cli", "mcp", "unknown"]),
  // An adapter may set a verified client identifier in a later schema version.
  identity: z.literal("unavailable")
}).strict();
const runtime = z.object({
  package_version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
  git_head: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  fingerprint: hash
}).strict();
const base = {
  schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
  trace_id: uuid,
  request_id: uuid,
  timestamp: z.string().datetime({ offset: true }),
  repository_id: hash,
  client,
  runtime
};
const freshness = z.enum(["fresh", "stale", "unavailable"]);
const common = (eventType, payload) => z.object({
  ...base,
  event_type: z.literal(eventType),
  payload
}).strict();
const fields = {
  request_started: z.object({
    operation: z.enum(["index", "status", "query"]),
    query_capture: z.literal("unavailable"),
    task_fingerprint: hash.nullable()
  }).strict(),
  request_completed: z.object({
    operation: z.enum(["index", "status", "query"]),
    duration_ms: duration, status: z.enum(["success", "failure"]),
    error_code: z.enum(["none", "invalid_input", "index_error", "query_error"])
  }).strict().refine((value) => (value.status === "success") === (value.error_code === "none"),
    "status and error_code disagree"),
  index_status_checked: z.object({ freshness }).strict(),
  index_started: z.object({ force: z.boolean() }).strict(),
  index_completed: z.object({
    duration_ms: duration, status: z.enum(["success", "failure"]),
    changed_files: count.nullable(), error_code: z.enum(["none", "invalid_input", "index_error"])
  }).strict(),
  query_expanded: z.object({
    retrieval_mode: z.enum(["lexical", "project_anchor", "unavailable"]),
    alias_count: count,
    detected_intents: z.array(z.enum([
      "cli", "mcp", "entrypoint", "version", "config", "test",
      "api", "migration", "project", "other"
    ])).max(16)
  }).strict(),
  candidates_retrieved: z.object({ candidate_files: count }).strict(),
  graph_expanded: z.object({ added_files: count }).strict(),
  context_selected: z.object({
    must_read_count: count, maybe_read_count: count, test_count: count
  }).strict(),
  query_completed: z.object({
    duration_ms: duration, status: z.literal("success"),
    index_freshness: freshness, reindexed: z.enum(["yes", "no", "unavailable"]),
    must_read_count: count, maybe_read_count: count, test_count: count,
    full_bytes: count, compact_bytes: count,
    estimated_full_tokens: count.nullable(), estimated_compact_tokens: count.nullable(),
    token_estimation_method: z.literal("unavailable")
  }).strict().refine((value) => value.estimated_full_tokens === null
    && value.estimated_compact_tokens === null,
  "tokens cannot be reported before an estimator is defined"),
  query_failed: z.object({
    duration_ms: duration, status: z.literal("failure"),
    index_freshness: freshness, error_code: z.enum([
      "invalid_input", "index_unavailable", "query_error", "semantic_fallback"
    ])
  }).strict()
};

export const telemetryEventSchema = z.discriminatedUnion("event_type",
  eventTypes.map((type) => common(type, fields[type])));

export const effectSchema = z.discriminatedUnion("measurement_source", [
  z.object({
    measurement_source: z.literal("measured"),
    scope: z.literal("cce_output"),
    full_bytes: count, compact_bytes: count
  }).strict(),
  z.object({
    measurement_source: z.literal("estimated"),
    scope: z.literal("cce_output"),
    method: z.enum(["fixed_tokenizer_v1", "utf8_bytes_div_4_v1"]),
    full_tokens: count, compact_tokens: count
  }).strict(),
  z.object({
    measurement_source: z.literal("controlled_experiment"),
    scope: z.literal("agent_workflow"),
    experiment_id: uuid, without_cce_tokens: count,
    with_cce_tokens: count, same_task_and_agent: z.literal(true)
  }).strict()
]);

export function repositoryId(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || !repositoryRoot) {
    throw new TypeError("repositoryRoot is required");
  }
  // No repository path is retained by the contract.
  return createHash("sha256").update(repositoryRoot).digest("hex");
}

export function taskFingerprint(task) {
  if (typeof task !== "string" || !task) throw new TypeError("task is required");
  return createHash("sha256").update(task).digest("hex");
}

export function newTraceId() {
  return randomUUID();
}

export function createTelemetryEvent(input) {
  return telemetryEventSchema.parse(input);
}

export function createOutputEffect({ full, compact }) {
  if (typeof full !== "string" || typeof compact !== "string") {
    throw new TypeError("serialized output strings are required");
  }
  return effectSchema.parse({
    measurement_source: "measured", scope: "cce_output",
    full_bytes: Buffer.byteLength(full, "utf8"),
    compact_bytes: Buffer.byteLength(compact, "utf8")
  });
}
