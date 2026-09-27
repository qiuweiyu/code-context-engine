import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

export const SEMANTIC_PROVIDER_PROTOCOL = "cce.semantic-provider";
export const SEMANTIC_PROVIDER_VERSION = "1.0";
export const SEMANTIC_PROVIDER_SPEC_PROTOCOL = "cce.semantic-provider-spec";
export const SEMANTIC_PROVIDER_SPEC_VERSION = "1.0";

export const SEMANTIC_PROVIDER_DEFAULT_TIMEOUT_MS = 1500;
export const SEMANTIC_PROVIDER_MIN_TIMEOUT_MS = 100;
export const SEMANTIC_PROVIDER_MAX_TIMEOUT_MS = 10000;
export const SEMANTIC_PROVIDER_DEFAULT_WEIGHT = 0.25;
export const SEMANTIC_PROVIDER_MAX_WEIGHT = 0.35;
export const SEMANTIC_PROVIDER_MAX_CANDIDATES = 64;

const MAX_COMMAND_LENGTH = 1024;
const MAX_ARG_LENGTH = 2048;
const MAX_ARGS = 32;
const MAX_TASK_LENGTH = 8192;
const MAX_PATH_LENGTH = 4096;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_PROVIDER_VERSION_LENGTH = 64;
const MAX_METADATA_ITEMS = 16;
const MAX_METADATA_STRING_LENGTH = 512;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value;
}

function requireOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(label + " contains unsupported field: " + key);
    }
  }
}

function requireString(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(label + " must be a non-empty string");
  }
  if (value.length > maxLength) {
    throw new Error(label + " exceeds maximum length");
  }
  return value;
}

function requireFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(label + " must be a finite number");
  }
  return value;
}

function validateRepoPath(value, label) {
  const raw = requireString(value, label, MAX_PATH_LENGTH).replaceAll("\\", "/");
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(label + " must be repository-relative");
  }
  const parts = raw.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(label + " contains invalid path components");
  }
  return raw;
}

function validateStringArray(value, label, maxItems = MAX_METADATA_ITEMS) {
  if (!Array.isArray(value)) throw new Error(label + " must be an array");
  if (value.length > maxItems) throw new Error(label + " exceeds maximum items");
  return value.map((entry, index) =>
    requireString(entry, `${label}[${index}]`, MAX_METADATA_STRING_LENGTH)
  );
}

function symbolHint(symbolId) {
  if (typeof symbolId !== "string" || symbolId.length === 0) return null;
  const separator = symbolId.indexOf("::");
  return separator >= 0 ? symbolId.slice(separator + 2) : symbolId;
}

function normalizeSymbolHints(value) {
  const source = value instanceof Set ? [...value] : (Array.isArray(value) ? value : []);
  const hints = [];
  const seen = new Set();
  for (const symbolId of source) {
    const hint = symbolHint(symbolId);
    if (!hint || seen.has(hint)) continue;
    requireString(hint, "symbol hint", MAX_METADATA_STRING_LENGTH);
    seen.add(hint);
    hints.push(hint);
    if (hints.length >= MAX_METADATA_ITEMS) break;
  }
  return hints;
}

function normalizeReasons(value) {
  if (!Array.isArray(value)) return [];
  const reasons = [];
  for (const reason of value) {
    if (typeof reason !== "string" || reason.length === 0) continue;
    requireString(reason, "candidate reason", MAX_METADATA_STRING_LENGTH);
    reasons.push(reason);
    if (reasons.length >= MAX_METADATA_ITEMS) break;
  }
  return reasons;
}

export function validateSemanticProviderSpecV1(value) {
  requireObject(value, "semantic provider spec");
  requireOnlyKeys(
    value,
    new Set(["protocol", "version", "command", "args", "timeout_ms", "weight"]),
    "semantic provider spec"
  );
  if (value.protocol !== SEMANTIC_PROVIDER_SPEC_PROTOCOL) {
    throw new Error("unsupported semantic provider spec protocol");
  }
  if (value.version !== SEMANTIC_PROVIDER_SPEC_VERSION) {
    throw new Error("unsupported semantic provider spec version");
  }
  const command = requireString(value.command, "semantic provider command", MAX_COMMAND_LENGTH);
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARGS) {
    throw new Error("semantic provider args must be an array with at most " + MAX_ARGS + " items");
  }
  const normalizedArgs = args.map((arg, index) =>
    requireString(arg, `semantic provider arg[${index}]`, MAX_ARG_LENGTH)
  );
  const timeoutMs = value.timeout_ms ?? SEMANTIC_PROVIDER_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs)
      || timeoutMs < SEMANTIC_PROVIDER_MIN_TIMEOUT_MS
      || timeoutMs > SEMANTIC_PROVIDER_MAX_TIMEOUT_MS) {
    throw new Error("semantic provider timeout_ms is outside the supported range");
  }
  const weight = value.weight ?? SEMANTIC_PROVIDER_DEFAULT_WEIGHT;
  requireFiniteNumber(weight, "semantic provider weight");
  if (weight < 0 || weight > SEMANTIC_PROVIDER_MAX_WEIGHT) {
    throw new Error("semantic provider weight is outside the supported range");
  }
  return {
    protocol: SEMANTIC_PROVIDER_SPEC_PROTOCOL,
    version: SEMANTIC_PROVIDER_SPEC_VERSION,
    command,
    args: normalizedArgs,
    timeout_ms: timeoutMs,
    weight
  };
}

export function loadSemanticProviderSpecV1(specPath) {
  requireString(specPath, "semantic provider spec path", MAX_PATH_LENGTH);
  const parsed = JSON.parse(fs.readFileSync(specPath, "utf8"));
  return validateSemanticProviderSpecV1(parsed);
}

export function createSemanticProviderRequestV1({
  requestId = crypto.randomUUID(),
  task,
  candidates
}) {
  requireString(requestId, "semantic provider request id", MAX_REQUEST_ID_LENGTH);
  requireString(task, "semantic provider task", MAX_TASK_LENGTH);
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("semantic provider candidates must be a non-empty array");
  }
  if (candidates.length > SEMANTIC_PROVIDER_MAX_CANDIDATES) {
    throw new Error(
      "semantic provider candidates exceed maximum of " + SEMANTIC_PROVIDER_MAX_CANDIDATES
    );
  }

  const seenPaths = new Set();
  const normalized = candidates.map((candidate, index) => {
    requireObject(candidate, "semantic provider candidate");
    const candidatePath = validateRepoPath(candidate.path, "candidate path");
    if (seenPaths.has(candidatePath)) {
      throw new Error("duplicate semantic provider candidate path");
    }
    seenPaths.add(candidatePath);
    const score = requireFiniteNumber(
      candidate.deterministic_score ?? candidate.score,
      "candidate deterministic score"
    );
    return {
      path: candidatePath,
      deterministic_rank: index + 1,
      deterministic_score: score,
      reasons: normalizeReasons(candidate.reasons),
      symbol_hints: normalizeSymbolHints(candidate.symbol_hints ?? candidate.symbols)
    };
  });

  return {
    protocol: SEMANTIC_PROVIDER_PROTOCOL,
    version: SEMANTIC_PROVIDER_VERSION,
    request_id: requestId,
    task,
    candidates: normalized
  };
}

export function validateSemanticProviderRequestV1(value) {
  requireObject(value, "semantic provider request");
  requireOnlyKeys(
    value,
    new Set(["protocol", "version", "request_id", "task", "candidates"]),
    "semantic provider request"
  );
  if (value.protocol !== SEMANTIC_PROVIDER_PROTOCOL) {
    throw new Error("unsupported semantic provider protocol");
  }
  if (value.version !== SEMANTIC_PROVIDER_VERSION) {
    throw new Error("unsupported semantic provider version");
  }
  requireString(value.request_id, "semantic provider request id", MAX_REQUEST_ID_LENGTH);
  requireString(value.task, "semantic provider task", MAX_TASK_LENGTH);
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new Error("semantic provider candidates must be a non-empty array");
  }
  if (value.candidates.length > SEMANTIC_PROVIDER_MAX_CANDIDATES) {
    throw new Error("semantic provider candidates exceed maximum");
  }

  const seenPaths = new Set();
  value.candidates.forEach((candidate, index) => {
    requireObject(candidate, "semantic provider candidate");
    requireOnlyKeys(
      candidate,
      new Set([
        "path",
        "deterministic_rank",
        "deterministic_score",
        "reasons",
        "symbol_hints"
      ]),
      "semantic provider candidate"
    );
    const candidatePath = validateRepoPath(candidate.path, "candidate path");
    if (seenPaths.has(candidatePath)) {
      throw new Error("duplicate semantic provider candidate path");
    }
    seenPaths.add(candidatePath);
    if (candidate.deterministic_rank !== index + 1) {
      throw new Error("semantic provider candidate ranks must be contiguous and one-based");
    }
    requireFiniteNumber(candidate.deterministic_score, "candidate deterministic score");
    validateStringArray(candidate.reasons, "candidate reasons");
    validateStringArray(candidate.symbol_hints, "candidate symbol_hints");
  });
  return value;
}

export function validateSemanticProviderResponseV1(value, request) {
  validateSemanticProviderRequestV1(request);
  requireObject(value, "semantic provider response");
  requireOnlyKeys(
    value,
    new Set(["protocol", "version", "request_id", "provider", "scores", "diagnostics"]),
    "semantic provider response"
  );
  if (value.protocol !== SEMANTIC_PROVIDER_PROTOCOL) {
    throw new Error("unsupported semantic provider protocol");
  }
  if (value.version !== request.version) {
    throw new Error("semantic provider response version mismatch");
  }
  if (value.request_id !== request.request_id) {
    throw new Error("semantic provider response request_id mismatch");
  }

  requireObject(value.provider, "semantic provider identity");
  requireOnlyKeys(
    value.provider,
    new Set(["id", "version"]),
    "semantic provider identity"
  );
  requireString(value.provider.id, "semantic provider id", MAX_PROVIDER_ID_LENGTH);
  requireString(
    value.provider.version,
    "semantic provider version",
    MAX_PROVIDER_VERSION_LENGTH
  );

  if (!Array.isArray(value.scores)) {
    throw new Error("semantic provider scores must be an array");
  }
  if (value.scores.length !== request.candidates.length) {
    throw new Error("semantic provider must score every candidate exactly once");
  }

  const requestedPaths = new Set(request.candidates.map((candidate) => candidate.path));
  const seenPaths = new Set();
  for (const score of value.scores) {
    requireObject(score, "semantic provider score");
    requireOnlyKeys(
      score,
      new Set(["path", "semantic_score", "reason"]),
      "semantic provider score"
    );
    const scorePath = validateRepoPath(score.path, "semantic score path");
    if (!requestedPaths.has(scorePath)) {
      throw new Error("semantic provider returned unknown candidate path");
    }
    if (seenPaths.has(scorePath)) {
      throw new Error("duplicate semantic provider score path");
    }
    seenPaths.add(scorePath);
    const semanticScore = requireFiniteNumber(score.semantic_score, "semantic score");
    if (semanticScore < 0 || semanticScore > 1) {
      throw new Error("semantic score is outside [0,1]");
    }
    if (score.reason !== undefined) {
      requireString(score.reason, "semantic score reason", MAX_METADATA_STRING_LENGTH);
    }
  }

  for (const candidate of request.candidates) {
    if (!seenPaths.has(candidate.path)) {
      throw new Error("semantic provider response is missing candidate score");
    }
  }
  if (value.diagnostics !== undefined) {
    validateStringArray(value.diagnostics, "semantic provider diagnostics");
  }
  return value;
}

function fallback(code, message, durationMs, stderr = "") {
  const result = {
    status: "fallback",
    error: {
      code,
      message
    },
    duration_ms: durationMs
  };
  const diagnostic = stderr.trim();
  if (diagnostic) result.stderr = diagnostic.slice(0, MAX_STDERR_BYTES);
  return result;
}

function runProcess(spec, request) {
  const started = performance.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      resolve(fallback(
        "spawn_error",
        error instanceof Error ? error.message : "provider spawn failed",
        Number((performance.now() - started).toFixed(2))
      ));
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let killedForLimit = false;
    let timedOut = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, spec.timeout_ms);

    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
        killedForLimit = true;
        child.kill("SIGKILL");
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length >= MAX_STDERR_BYTES) return;
      stderr = Buffer.concat([
        stderr,
        chunk.subarray(0, MAX_STDERR_BYTES - stderr.length)
      ]);
    });

    child.on("error", (error) => {
      finish(fallback(
        "spawn_error",
        error instanceof Error ? error.message : "provider process error",
        Number((performance.now() - started).toFixed(2)),
        stderr.toString("utf8")
      ));
    });

    child.stdin.on("error", (error) => {
      child.kill("SIGKILL");
      finish(fallback(
        "stdin_error",
        error instanceof Error ? error.message : "provider stdin failed",
        Number((performance.now() - started).toFixed(2)),
        stderr.toString("utf8")
      ));
    });

    child.on("close", (code, signal) => {
      const durationMs = Number((performance.now() - started).toFixed(2));
      if (timedOut) {
        finish(fallback(
          "timeout",
          "semantic provider exceeded timeout",
          durationMs,
          stderr.toString("utf8")
        ));
        return;
      }
      if (killedForLimit) {
        finish(fallback(
          "stdout_limit",
          "semantic provider stdout exceeded limit",
          durationMs,
          stderr.toString("utf8")
        ));
        return;
      }
      if (code !== 0) {
        finish(fallback(
          "exit_nonzero",
          `semantic provider exited with code ${code ?? "null"} signal ${signal ?? "none"}`,
          durationMs,
          stderr.toString("utf8")
        ));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.toString("utf8"));
      } catch {
        finish(fallback(
          "invalid_json",
          "semantic provider stdout is not valid JSON",
          durationMs,
          stderr.toString("utf8")
        ));
        return;
      }
      try {
        const response = validateSemanticProviderResponseV1(parsed, request);
        finish({
          status: "applied",
          provider: {
            id: response.provider.id,
            version: response.provider.version
          },
          scores: response.scores,
          diagnostics: response.diagnostics ?? [],
          duration_ms: durationMs
        });
      } catch (error) {
        finish(fallback(
          "invalid_response",
          error instanceof Error ? error.message : "semantic provider response is invalid",
          durationMs,
          stderr.toString("utf8")
        ));
      }
    });

    try {
      child.stdin.end(JSON.stringify(request));
    } catch (error) {
      child.kill("SIGKILL");
      finish(fallback(
        "stdin_error",
        error instanceof Error ? error.message : "provider stdin failed",
        Number((performance.now() - started).toFixed(2)),
        stderr.toString("utf8")
      ));
    }
  });
}

export async function runSemanticProviderV1({ spec, request }) {
  let normalizedSpec;
  try {
    normalizedSpec = validateSemanticProviderSpecV1(spec);
  } catch (error) {
    return fallback(
      "invalid_spec",
      error instanceof Error ? error.message : "semantic provider spec is invalid",
      0
    );
  }
  try {
    validateSemanticProviderRequestV1(request);
  } catch (error) {
    return fallback(
      "invalid_request",
      error instanceof Error ? error.message : "semantic provider request is invalid",
      0
    );
  }
  return runProcess(normalizedSpec, request);
}
