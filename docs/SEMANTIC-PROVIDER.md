# Semantic Provider Protocol v1

Status: WP17 Stage 1 architecture freeze.

This document defines the first optional semantic-provider boundary for Code Context Engine (CCE). It is intentionally small, local-first, vendor-neutral and subordinate to the deterministic engine.

## 1. Non-negotiable invariants

The deterministic analyzer, typed graph and retriever remain authoritative.

A semantic provider:

- MUST be explicitly enabled by the caller.
- MUST NOT run merely because `semantic_refinement_recommended=true`.
- MUST NOT create, delete or mutate graph facts.
- MUST NOT change edge confidence.
- MUST NOT introduce a file that is not already in the deterministic candidate set.
- MUST NOT receive repository source-file bodies from CCE.
- MUST NOT be required for normal indexing, querying, flow traversal, Public Index, SCIP, locate or graph-html behavior.
- MUST NOT be required by CI, and the CCE core MUST NOT require a vendor SDK, model API key, embedding runtime or network access.
- MAY only provide a bounded semantic score for candidates already produced by the deterministic retriever.

If provider execution fails, times out or returns an invalid result, CCE MUST return the deterministic result rather than fail the query.

## 2. Transport

Protocol v1 uses a local external process.

CCE starts an explicitly configured executable, writes exactly one UTF-8 JSON request to stdin, closes stdin, then expects exactly one UTF-8 JSON response on stdout.

Provider stderr is diagnostic only and MUST NOT be parsed as protocol data.

A non-zero exit code, timeout, malformed JSON, unsupported protocol version or schema violation causes deterministic fallback.

The transport is deliberately language-neutral. A provider can be implemented in Node.js, Python, Go, Java or another runtime. The protocol does not imply that the provider itself is prohibited from using a network; it means CCE never requires network access and never silently enables one.

## 3. Provider configuration

The initial integration SHOULD use an explicit local provider-spec JSON file rather than vendor-specific CLI flags.

Example:

```json
{
  "protocol": "cce.semantic-provider-spec",
  "version": "1.0",
  "command": "python3",
  "args": ["./tools/semantic-provider.py"],
  "timeout_ms": 1500,
  "weight": 0.25
}
```

Rules:

- `command` is required and non-empty.
- `args` defaults to an empty array.
- `timeout_ms` MUST be bounded. WP17 implementation target: 100–10000 ms, default 1500 ms.
- `weight` MUST be between 0 and 0.35 inclusive. Default: 0.25.
- Shell interpolation is not part of the protocol. CCE SHOULD spawn the command directly with an argument array.

## 4. Request schema

Protocol identifier:

```text
cce.semantic-provider
```

Major version:

```text
1
```

Example request:

```json
{
  "protocol": "cce.semantic-provider",
  "version": "1.0",
  "request_id": "opaque-per-query-id",
  "task": "find where a teacher publishes homework",
  "candidates": [
    {
      "path": "src/example.js",
      "deterministic_rank": 1,
      "deterministic_score": 42.5,
      "reasons": ["symbol_match", "route:POST /homework"],
      "symbol_hints": ["HomeworkService.publish"]
    }
  ]
}
```

Normative rules:

- `request_id` is opaque and unique for the process invocation.
- `task` is the caller's query text.
- `candidates` contains only deterministic candidates.
- Candidate paths MUST be repository-relative normalized paths already known to the retriever.
- `deterministic_rank` is one-based and reflects the pre-provider ordering.
- `deterministic_score` is debug metadata only. Providers MUST NOT assume a stable cross-version score scale.
- `reasons` and `symbol_hints` are bounded metadata, not source text.
- CCE MUST NOT include file bodies, arbitrary filesystem content, the SQLite database, environment secrets or credential material.
- Request candidates MUST be bounded. WP17 integration target: at most 64 candidates.
- The candidate pool SHOULD be the smallest bounded prefix that still gives the provider room to improve final selection. Initial integration target: `min(rankedFiles.length, max(24, maxFiles * 3), 64)`.

## 5. Response schema

Example response:

```json
{
  "protocol": "cce.semantic-provider",
  "version": "1.0",
  "request_id": "opaque-per-query-id",
  "provider": {
    "id": "example.semantic",
    "version": "0.1.0"
  },
  "scores": [
    {
      "path": "src/example.js",
      "semantic_score": 0.93,
      "reason": "homework publishing intent matches publish handler"
    }
  ],
  "diagnostics": []
}
```

Normative rules:

- `protocol`, major version and `request_id` MUST match the request.
- `provider.id` and `provider.version` MUST be non-empty strings.
- Every request candidate MUST appear exactly once in `scores`.
- A response MUST NOT contain an unknown path.
- Duplicate paths are invalid.
- `semantic_score` MUST be a finite number in the inclusive range [0, 1].
- `reason` is optional, bounded diagnostic text.
- `diagnostics` is optional bounded diagnostic metadata.
- Any violation invalidates the entire response. Protocol v1 does not partially apply a malformed provider result.

## 6. Deterministic/semantic fusion

WP17 uses bounded rank-based fusion so that provider scoring never becomes the fact source and never depends on the historical numeric scale of deterministic scores.

For a candidate pool of `N` files:

```text
deterministic_component =
    N <= 1
      ? 1
      : 1 - ((deterministic_rank - 1) / (N - 1))

semantic_component = semantic_score

fused_score =
    (1 - weight) * deterministic_component
    + weight * semantic_component
```

Constraints:

- default `weight = 0.25`
- maximum `weight = 0.35`
- minimum `weight = 0`

Final ordering:

1. `fused_score` descending
2. original `deterministic_rank` ascending
3. `path` ascending

The deterministic raw score, reasons and original rank remain available for debug output and are not overwritten.

Why rank normalization is used:

- existing deterministic score channels use different magnitudes;
- the provider must not depend on internal score-scale accidents;
- a bounded weight makes the semantic contribution auditable;
- stable tie-breaking keeps repeated runs reproducible for a deterministic provider.

## 7. Query integration point

The provider is applied:

```text
deterministic candidate generation
        ↓
deterministic ranking
        ↓
bounded semantic candidate prefix
        ↓
optional provider
        ↓
validated bounded fusion
        ↓
existing final selection / maxFiles
```

The provider MUST NOT run before deterministic candidate generation and MUST NOT bypass the existing candidate set.

When no provider is requested, CCE MUST preserve the current deterministic path. WP17 acceptance should verify compatibility with the WP16 query baseline.

## 8. Failure behavior

Provider outcomes are classified as:

- `disabled`: caller did not request a provider.
- `applied`: valid provider response was fused.
- `fallback`: provider was requested but was not applied because of timeout, process failure or validation failure.

For `fallback`:

- the query remains `ok: true` when deterministic retrieval itself succeeded;
- candidate ordering and selection use the original deterministic result;
- a bounded provider diagnostic is exposed in full/debug output;
- compact output SHOULD expose only a small provider status when a provider was explicitly requested.

There is no retry loop in Protocol v1.

## 9. Privacy boundary

CCE-owned provider requests may contain:

- task text;
- repository-relative candidate paths;
- deterministic ranks/scores;
- deterministic retrieval reasons;
- bounded symbol-name hints already present in the index.

CCE-owned provider requests MUST NOT contain:

- full source files or source snippets;
- arbitrary file reads;
- SQLite contents;
- environment variables;
- tokens, passwords or credential files.

WP17 tests MUST inspect serialized provider requests and lock this boundary.

## 10. Measurement contract

A provider is an optional retrieval enhancement, so its value must be measured as OFF versus ON.

WP17 must record:

- Top-K retrieval;
- MRR;
- selected relevant files on predeclared semantic/paraphrase cases;
- query latency;
- output bytes;
- fallback behavior;
- unchanged graph-fact TP/FP/FN, because semantic providers do not own facts.

Provider-disabled benchmark and regression behavior must remain compatible with the WP16 baseline.

## 11. Machine-readable schemas

Protocol v1 is accompanied by strict JSON Schemas:

- `docs/schema/semantic-provider-spec-v1.schema.json`
- `docs/schema/semantic-provider-request-v1.schema.json`
- `docs/schema/semantic-provider-response-v1.schema.json`

Cross-record invariants that JSON Schema does not express conveniently — such as exact candidate/score path equality, duplicate path rejection and matching request IDs — remain mandatory validator logic in the implementation.

## 12. CLI and MCP opt-in

The deterministic query path remains the default.

CLI:

```bash
cce query --repo /path/to/repo --task "find homework publishing" --semantic-provider /path/to/provider.json
```

The CLI spec path is an explicit local file path. When `--semantic-provider` is absent, the command uses the original synchronous deterministic query path.

MCP `context_query` accepts an optional `semantic_provider` string:

```json
{
  "repo_root": "/path/to/repo",
  "task": "find homework publishing",
  "semantic_provider": ".cce/semantic-provider.json"
}
```

For MCP, the spec path is resolved relative to `repo_root` and MUST remain inside that authorized repository root. This prevents a model-generated tool call from reading an arbitrary provider spec elsewhere on the host.

Full query output includes `semantic_refinement` only when a provider was explicitly requested. Compact output exposes only bounded status:

- applied: `{"status":"applied","provider":"<id>"}`
- fallback: `{"status":"fallback","error_code":"<code>"}`

Provider-disabled output does not gain a semantic status field, preserving the deterministic default serialization.

## 13. Out of scope for Protocol v1

- automatic provider discovery;
- automatic network calls;
- a vendor-specific OpenAI/Anthropic/Gemini/Ollama interface in CCE core;
- embedding database management;
- provider-created graph facts;
- provider-created edges or confidence promotion;
- source upload;
- agent loops;
- Java/Python/C/C++ language-adapter work.
