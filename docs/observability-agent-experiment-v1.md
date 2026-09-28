# WP20-G: paired Coding Agent benefit evaluation (v1)

WP20-G asks whether a Coding Agent reads fewer files, searches less, and uses fewer model tokens for the same task when CCE is available. The v0.3.0 Effects page remains at controlled_experiment: unavailable until reviewed Agent exports exist. This repository contains no real paired Agent runs as of 2026-09-28.

## Frozen procedure

1. Use two clean local workspaces from the same pinned source commit per task. Keep Agent name, model, version, task prompt, success rubric, tool permissions, time budget and dependency set identical. Do not allow an arm to inspect future Git history or the other arm's transcript.
2. Run two separate Agent sessions. In without_cce, disable CCE CLI/MCP. In with_cce, make it available, but do not force a query. Record whether the Agent chose to call it. Counterbalance arm order over the corpus (three CCE-first, three without-CCE-first).
3. Capture the actual Agent tool log: every search, every file read with bytes returned to the Agent, CCE query, and edited path. Save the original session export outside the repository with a SHA-256 fingerprint. Record reported model input tokens only if the Agent/provider exposes them for both sessions. Do not derive billing tokens from source bytes.
4. Check the same rubric for both outcomes. A failed/incomplete arm does not establish a token saving; keep it as a diagnosis. Review tool-log completeness and attribution before marking a session verified.
5. Compare selected CCE paths with paths the Agent actually read. selected_not_read is an unused recommendation and read_not_selected a possible gap, not automatically a false positive/false negative. Independent relevance labels are needed for precision and recall.
6. Keep raw exports, queries, paths, and answers local; never check them into Git or copy source bodies into telemetry. Export only aggregate counts or anonymous task IDs. No UI import is enabled in v1.

## Six first-panel tasks

All six use the public CCE source snapshot at e5a9d333bf9d993d5266ed4edfe15343c1c3617e. These are real developer investigation tasks, with no required source edits; later experiments should add coding tasks before generalizing to end-to-end development savings. Each Agent must identify the implementation and relevant tests and explain the relationship, not merely list filenames.

| ID | Same prompt for both sessions | Independent success rubric |
| --- | --- | --- |
| cli_version | Locate how cce --version obtains its value and how it is tested. | Identify CLI flag handling, package version source and CLI version test. |
| mcp_compact | Locate the MCP context_query entry and the Compact output conversion. | Identify MCP tool handler, retrieval entry and Compact projector. |
| index_freshness | Find how index status detects working-tree and runtime staleness. | Identify status/freshness implementation and relevant regression test. |
| local_api | Find how the local observability API prevents remote access and serves request detail. | Identify API host/origin and read-only guards plus API tests. |
| effect_metrics | Trace Full/Compact byte measurement through estimated Token totals. | Identify event measurement, estimator/aggregation and Effects API test. |
| packed_ui | Find how the release smoke verifies the installed observability UI. | Identify npm package surface, tarball smoke and UI serving. |

Rubric owner should write path-level labels in a separate local private rubric file before reviewing any Agent output. Use two isolated sessions per task; randomize order with a recorded seed. These prompts test navigation only, so a positive result cannot be advertised as a reduction in total tokens for coding and editing.

## CCE-only preflight (not an Agent experiment)

The six exact prompts above were queried once against an isolated checkout of the pinned public repository. These are actual CCE Compact results (serialized bytes exclude CLI newline), not Agent reads, input tokens, or without-CCE baselines. The lookup exposed misses before any paired Agent trial:

| Task | Observed anchor results | Rubric anchors absent from CCE selection | Compact bytes |
| --- | --- | --- | ---: |
| cli_version | package.json | src/cli.js, test/cli-version.test.mjs | 1,395 |
| mcp_compact | src/server.js, src/context/retriever.js, src/context/query-output.js | test/query-output.test.mjs | 1,778 |
| index_freshness | src/context/status.js, src/context/indexer.js | test/index-status-freshness.test.mjs | 1,678 |
| local_api | src/observability/api.js, test/observability-api.test.mjs | none among these two labels | 1,789 |
| effect_metrics | src/observability/effects.js, test/observability-effects.test.mjs | src/observability/record.js | 1,359 |
| packed_ui | scripts/release-smoke.mjs, src/observability/api.js | package.json, src/observability/ui/index.html | 1,569 |

CCE also returned unrelated files in several tasks. The table lists only predeclared rubric anchors; it does not call unused files false positives or imply any model Token saving. These misses remain diagnostic evidence for future retrieval work, outside WP20-G.

## Record interface and current trust boundary

src/observability/agent-experiment.js validates a strict v1 pair with a task fingerprint, pinned repository commit, one Agent/model/version, two distinct session IDs and ordered arms. Each arm records search, read (relative path and bytes returned), edit, and cce_query; only the WITH arm can carry the CCE-selected must_read, maybe_read, and tests paths. If the Agent never calls CCE, selection diagnostics are unavailable; that arm remains a valid observed outcome. Each arm also declares outcome, capture kind, and optional Agent-reported input tokens.

Store private JSON records and original Agent exports outside the checkout. Run:

    node scripts/agent-experiment-report.mjs /absolute/private/task-a.json

With no input, the command returns unavailable. Hand-entered records and unchecked exports only produce observational diagnostics; the CLI cannot verify Agent tool attribution or activate Controlled Experiment. The pure evaluator accepts a set of independently verified session IDs so a future capture adapter can turn eligible pairs into controlled_experiment; it must parse the actual export and confirm operations/usage before passing verified IDs. A matching file hash alone is insufficient.

Output contains aggregate counts and no paths, raw query, source body, evidence filename, or user credential. source_bytes_read counts returned bytes from read operations, including repeat reads; it excludes search replies and CCE context. Only genuine Agent-reported input tokens could cover the whole session. The importer rejects unknown fields, secret-bearing/traversal paths, mismatched commits, reused sessions, contaminated WITHOUT arms, and incomplete claimed exports. The corpus and any comparison number are not shipped while no real Agent session is available. The local /effects endpoint stays unavailable for controlled comparisons.

## Current execution status

Remote Desktop Commander currently exposes Ubuntu only. This machine has no Codex/Claude CLI or usable Agent login state. Zero real pairs have run; no baseline or controlled token number is claimed. Connect an instrumentable Agent on Windows/Codex Desktop or export genuine local tool/usage logs to resume. Keep SGC-83 In Progress until the six tasks have complete audited pairs and a capture adapter can validate them.
