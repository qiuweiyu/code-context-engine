# WP20-A: local observability contract v1

This contract is a pure, versioned data boundary. It does not persist events, instrument
the CLI/MCP tools, start a server, or capture source. The implementation is
`src/observability/contract.js`. Consumers must validate events with
`createTelemetryEvent` before storing them. A breaking field change increments
`schema_version`.

## Envelope

Every event has `schema_version=1`, UUID `trace_id` and `request_id`,
ISO timestamp, SHA-256 `repository_id`, client transport, and runtime version,
Git HEAD (nullable) and fingerprint. IDs are generated once at the tool boundary
and reused by every event in one request. Passing a fixed envelope and payload
produces the same serialized JSON.

Client identity is `unavailable` in v1: MCP stdio cannot prove which application
called the tool. The transport may be `mcp`, `cli`, or `unknown`. Repository
path, full query, environment, raw error message, arbitrary metadata, and source
body have no event fields. `request_started.task_fingerprint` is SHA-256 of the
original task, or null for non-query operations. `query_capture` is always
`unavailable`. The UI must display the original query as unavailable until a
future explicit opt-in capture contract is reviewed.

## Events

`request_started` and `request_completed` bracket an operation. Index/status
events are `index_status_checked`, `index_started`, `index_completed`.
Query phases are `query_expanded`, `candidates_retrieved`, `graph_expanded`,
`context_selected`, `query_completed` and `query_failed`. Durations are
nonnegative milliseconds measured by the future adapter. Freshness and reindex
state can be `unavailable` when no actual observation occurred. The adapter
must never call `readIndexStatus` for every query only to fill this field:
that operation reads/hashes working-tree files. Current `context_query` does
not reindex automatically.

Counts are nonnegative integers. Error codes are a fixed vocabulary without
the original error text. Detected intent keys are bounded enums; project-specific
aliases can be categorized as `project`. Future trace detail (selected file
paths, graph evidence, detailed query text) needs a new vetted contract revision.

## Effects and provenance

`createOutputEffect({full, compact})` measures UTF-8 bytes of *the actual
serialized strings passed in*. Its source is `measured` and its scope is
`cce_output`. It says nothing about what an agent read or paid for.
`estimated` requires an explicit method and token counts; no estimator is
implemented in v1, so query completion token fields must be null.
`controlled_experiment` requires a recorded experiment ID and same-task,
same-agent comparison. It is a reserved data type; WP20-A generates no such
records. Consumers may not sum unlike scopes or report byte compression as
LLM token savings.

## Later stages

WP20-B adds an independent local store with bounded retention. WP20-C provides
loopback-only read APIs. WP20-D builds UI. WP20-E adds boundary adapters and
privacy-reviewed optional detail. WP20-F implements the fixed token estimator.
WP20-G collects actual agent workflow experiments and reads through an adapter.
