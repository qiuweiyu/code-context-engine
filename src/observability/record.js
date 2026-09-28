import { performance } from "node:perf_hooks";
import { openTelemetryStore } from "./store.js";
import { repositoryId, taskFingerprint, newTraceId, TELEMETRY_SCHEMA_VERSION } from "./contract.js";
import { runtimeIdentity } from "../runtime.js";
import { serializeQueryOutput } from "../context/query-output.js";

// Instrument only command/tool boundaries. A recorder failure never changes CCE's result.
export function createRequestRecorder({
  transport, storeFactory = openTelemetryStore,
  runtimeFactory = runtimeIdentity, now = () => new Date(),
  tick = () => performance.now()
}) {
  if (!["cli", "mcp"].includes(transport)) throw new RangeError("invalid transport");
  let store;
  let runtime;
  let disabled = false;
  function emit(envelope, event_type, payload) {
    if (!envelope || disabled) return;
    try {
      store ??= storeFactory();
      store.appendEvent({ ...envelope, timestamp: now().toISOString(), event_type, payload });
    } catch {
      disabled = true;
      try { store?.close(); } catch {}
    }
  }
  function identity(repoRoot) {
    try {
      const observed = runtime ??= runtimeFactory();
      return {
        schema_version: TELEMETRY_SCHEMA_VERSION,
        trace_id: newTraceId(), request_id: newTraceId(),
        repository_id: repositoryId(repoRoot),
        client: { transport, identity: "unavailable" },
        runtime: {
          package_version: observed.package_version,
          git_head: observed.runtime_git_head,
          fingerprint: observed.runtime_fingerprint
        }
      };
    } catch { return null; }
  }
  async function run({ operation, repoRoot, task = null, force = false, execute }) {
    const envelope = disabled ? null : identity(repoRoot);
    emit(envelope, "request_started", {
      operation, query_capture: "unavailable",
      task_fingerprint: operation === "query" && typeof task === "string" && task
        ? taskFingerprint(task) : null
    });
    if (operation === "index") emit(envelope, "index_started", { force: Boolean(force) });
    const started = tick();
    let result;
    try {
      result = await execute();
    } catch (error) {
      const duration_ms = Math.max(0, tick() - started);
      const code = error instanceof TypeError || error instanceof RangeError
        || error?.message === "repo_root is outside CCE_ALLOWED_ROOTS"
        ? "invalid_input" : operation === "index" ? "index_error" : "query_error";
      if (operation === "query") emit(envelope, "query_failed", {
        duration_ms, status: "failure", index_freshness: "unavailable", error_code: code
      });
      if (operation === "index") emit(envelope, "index_completed", {
        duration_ms, status: "failure", changed_files: null, error_code: code
      });
      emit(envelope, "request_completed", {
        operation, duration_ms, status: "failure", error_code: code
      });
      throw error;
    }
    const duration_ms = Math.max(0, tick() - started);
    if (result?.ok === false) {
      const error_code = operation === "index" ? "index_error" : "query_error";
      if (operation === "query") emit(envelope, "query_failed", {
        duration_ms, status: "failure", index_freshness: "unavailable", error_code
      });
      if (operation === "index") emit(envelope, "index_completed", {
        duration_ms, status: "failure", changed_files: null, error_code
      });
      emit(envelope, "request_completed", {
        operation, duration_ms, status: "failure", error_code
      });
      return result;
    }
    if (operation === "status") emit(envelope, "index_status_checked", {
      freshness: result?.stale === true ? "stale"
        : result?.stale === false ? "fresh" : "unavailable"
    });
    if (operation === "index") emit(envelope, "index_completed", {
      duration_ms, status: "success", changed_files: result.changed_files ?? null,
      error_code: "none"
    });
    if (operation === "query" && envelope && !disabled) {
      try {
      // Never store task, paths, symbols, scores, source or provider messages.
      const expansion = result?.query_expansion;
      const intents = [...new Set((expansion?.applied_aliases ?? [])
        .filter((entry) => entry.source === "developer")
        .map((entry) => {
          const key = entry.key.toLowerCase();
          if (["命令行", "cli"].includes(key)) return "cli";
          if (["入口", "entrypoint"].includes(key)) return "entrypoint";
          if (["版本", "version"].includes(key)) return "version";
          if (["配置", "config"].includes(key)) return "config";
          if (["测试", "test"].includes(key)) return "test";
          if (["迁移"].includes(key)) return "migration";
          return key;
        }).filter((value) => ["cli","mcp","entrypoint","version","config","test","api","migration"].includes(value)))];
      emit(envelope, "query_expanded", {
        retrieval_mode: ["lexical","project_anchor"].includes(expansion?.retrieval_mode)
          ? expansion.retrieval_mode : "unavailable",
        alias_count: expansion?.applied_aliases?.length ?? 0, detected_intents: intents
      });
      emit(envelope, "candidates_retrieved", {
        candidate_files: result?.coverage?.candidate_files ?? 0
      });
      emit(envelope, "graph_expanded", {
        added_files: result?.graph_expansion?.added_files ?? 0
      });
      const selected = {
        must_read_count: result?.must_read?.length ?? 0,
        maybe_read_count: result?.maybe_read?.length ?? 0,
        test_count: result?.tests?.length ?? 0
      };
      emit(envelope, "context_selected", selected);
      try {
        emit(envelope, "query_completed", {
          duration_ms, status: "success", index_freshness: "unavailable",
          reindexed: "no", ...selected,
          full_bytes: Buffer.byteLength(serializeQueryOutput(result), "utf8"),
          compact_bytes: Buffer.byteLength(serializeQueryOutput(result, { compact: true }), "utf8"),
          estimated_full_tokens: null, estimated_compact_tokens: null,
          token_estimation_method: "unavailable", measurement_source: "measured",
          ...(result?.semantic_refinement?.status === "fallback" ? { semantic_fallback: true } : {})
        });
      } catch { /* measurement failure does not change the query */ }
      } catch { /* telemetry projection must never change the query result */ }
    }
    emit(envelope, "request_completed", {
      operation, duration_ms, status: "success", error_code: "none"
    });
    return result;
  }
  return {
    run,
    close() {
      try { store?.close(); } catch {}
      store = null;
      disabled = true;
    }
  };
}
