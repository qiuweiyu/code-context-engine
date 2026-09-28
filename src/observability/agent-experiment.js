import path from "node:path";
import { z } from "zod";
import { isBlockedFile } from "../security.js";

export const AGENT_EXPERIMENT_SCHEMA_VERSION = 1;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const head = z.string().regex(/^[a-f0-9]{40}$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/);
const filePath = z.string().min(1).max(400).refine((value) => {
  const segments = value.split("/");
  const base = path.posix.basename(value).toLowerCase();
  return !value.includes("\\") && !value.includes(":") && !/[\x00-\x1f\x7f]/.test(value)
    && !value.startsWith("/")
    && segments.every((part) => part && part !== "." && part !== ".."
      && ![".git", "node_modules", "vendor"].includes(part.toLowerCase()))
    && !/^\.env(?:\.|$)/.test(base) && !isBlockedFile(value);
}, "unsafe or blocked repository path");
const read = z.object({ type: z.literal("read"), path: filePath, bytes: count }).strict();
const edit = z.object({ type: z.literal("edit"), path: filePath }).strict();
const search = z.object({ type: z.literal("search") }).strict();
const cceQuery = z.object({ type: z.literal("cce_query") }).strict();
const selection = z.object({
  must_read: z.array(filePath).max(100),
  maybe_read: z.array(filePath).max(100),
  tests: z.array(filePath).max(100)
}).strict().refine((value) => {
  const paths = [...value.must_read, ...value.maybe_read, ...value.tests];
  return paths.length === new Set(paths).size;
}, "selected paths must be unique");
const run = z.object({
  arm: z.enum(["without_cce", "with_cce"]),
  session_id: z.string().uuid(),
  order: z.union([z.literal(1), z.literal(2)]),
  repository_head: head,
  outcome: z.enum(["success", "failure"]),
  capture: z.object({
    kind: z.enum(["manual", "agent_export"]),
    complete: z.boolean(),
    evidence_file: z.string().min(1).max(400).nullable(),
    evidence_sha256: digest.nullable()
  }).strict(),
  operations: z.array(z.discriminatedUnion("type", [read, edit, search, cceQuery])).max(10000),
  selection: selection.nullable(),
  usage: z.object({ source: z.literal("agent_reported"), input_tokens: count }).strict().nullable()
}).strict().superRefine((value, ctx) => {
  if (value.arm === "without_cce" &&
    (value.selection !== null || value.operations.some((op) => op.type === "cce_query"))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "without_cce cannot use CCE" });
  }
  if (value.arm === "with_cce" &&
    (value.selection === null) !== !value.operations.some((op) => op.type === "cce_query")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CCE selection must match observed query use" });
  }
  if (value.capture.kind === "agent_export" &&
    (!value.capture.complete || !value.capture.evidence_file || !value.capture.evidence_sha256)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agent export needs complete evidence" });
  }
  if (value.capture.kind === "manual" &&
    (value.capture.evidence_file !== null || value.capture.evidence_sha256 !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "manual capture cannot claim export evidence" });
  }
});
export const agentExperimentSchema = z.object({
  schema_version: z.literal(AGENT_EXPERIMENT_SCHEMA_VERSION),
  task_id: slug,
  task_fingerprint: digest,
  rubric_id: slug,
  repository_head: head,
  agent: z.object({
    name: z.string().min(1).max(60),
    model: z.string().min(1).max(80),
    version: z.string().min(1).max(80)
  }).strict(),
  runs: z.tuple([run, run])
}).strict().superRefine((value, ctx) => {
  const [first, second] = value.runs;
  if (first.arm === second.arm || first.order === second.order ||
    first.session_id === second.session_id ||
    value.runs.some((entry) => entry.repository_head !== value.repository_head)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "paired runs must be separate, ordered and use one commit" });
  }
});

function summarizeRun(runData) {
  const reads = runData.operations.filter((entry) => entry.type === "read");
  const readPaths = new Set(reads.map((entry) => entry.path));
  const editedPaths = new Set(runData.operations
    .filter((entry) => entry.type === "edit").map((entry) => entry.path));
  return {
    files_read: readPaths.size,
    read_operations: reads.length,
    source_bytes_read: reads.reduce((total, entry) => total + entry.bytes, 0),
    search_operations: runData.operations.filter((entry) => entry.type === "search").length,
    cce_queries: runData.operations.filter((entry) => entry.type === "cce_query").length,
    files_edited: editedPaths.size,
    outcome: runData.outcome,
    agent_reported_input_tokens: runData.usage?.input_tokens ?? null,
    readPaths
  };
}

// A verified evidence hash proves only which local export file was reviewed.
// Agent/tool attribution must still be checked by the capture adapter before calling this controlled.
export function evaluateAgentExperiment(raw, { verifiedSessions = new Set() } = {}) {
  const experiment = agentExperimentSchema.parse(raw);
  const without = experiment.runs.find((entry) => entry.arm === "without_cce");
  const withCce = experiment.runs.find((entry) => entry.arm === "with_cce");
  const left = summarizeRun(without);
  const right = summarizeRun(withCce);
  if (!Number.isSafeInteger(left.source_bytes_read) || !Number.isSafeInteger(right.source_bytes_read)) {
    throw new RangeError("source bytes overflow");
  }
  const selected = withCce.selection === null ? null : new Set([
    ...withCce.selection.must_read, ...withCce.selection.maybe_read, ...withCce.selection.tests
  ]);
  const exportVerified = experiment.runs.every((entry) =>
    entry.capture.kind === "agent_export" && verifiedSessions.has(entry.session_id));
  const complete = exportVerified && experiment.runs.every((entry) =>
    entry.outcome === "success" && entry.usage !== null);
  const reason = complete ? null
    : !exportVerified ? "verified_agent_exports_required"
      : experiment.runs.some((entry) => entry.outcome !== "success") ? "task_outcome_mismatch"
        : "agent_token_usage_unavailable";
  const metrics = ({ readPaths, ...rest }) => rest;
  return {
    schema_version: AGENT_EXPERIMENT_SCHEMA_VERSION,
    task_id: experiment.task_id,
    repository_head: experiment.repository_head,
    status: complete ? "controlled_experiment" : "observational",
    ...(complete ? { measurement_source: "controlled_experiment" } : {}),
    without_cce: metrics(left),
    with_cce: metrics(right),
    selected_path_diagnostics: selected === null ? null : {
      selected_and_read: [...selected].filter((name) => right.readPaths.has(name)).length,
      selected_not_read: [...selected].filter((name) => !right.readPaths.has(name)).length,
      read_not_selected: [...right.readPaths].filter((name) => !selected.has(name)).length
    },
    token_comparison: complete ? {
      measurement_source: "controlled_experiment",
      scope: "agent_workflow",
      without_cce_tokens: left.agent_reported_input_tokens,
      with_cce_tokens: right.agent_reported_input_tokens,
      difference_tokens: left.agent_reported_input_tokens - right.agent_reported_input_tokens
    } : { status: "unavailable", reason }
  };
}
