# WP20-E: runtime request traces

CCE records CLI and MCP `index`, `status`, and `query` calls at their
tool/command boundaries. Start `npm run start:observability` on the same
machine and open `http://127.0.0.1:8765/`. The API reads the same per-user
telemetry store used by CCE runtimes; it does not need to share a process.
Restart an already-running MCP process after updating CCE to activate tracing.

Each request gets independent UUID `trace_id` and `request_id`, a hash of
the repository path, a transport (`cli` or `mcp`), and runtime provenance.
The MCP protocol transport does not verify a client application name: the
client identity remains `unavailable` even when a handshake supplies one.
No raw task, repository path, selected path, source body or error text is
persisted. The task is fingerprinted only. Review the strict allowlist in
`src/observability/contract.js` before adding fields.

A successful query records expansion mode and alias/intent counts, candidate
and graph file counts, selected file counts, and UTF-8 byte lengths of the
exact full and compact CCE JSON serializers. It never calculates index
freshness or triggers reindex merely for telemetry; the query freshness is
`unavailable` and `reindexed` is `no`. A separate status call records
its *observed* fresh/stale result. A semantic provider fallback is marked on
a successful query, because deterministic retrieval still produced a result.
Byte lengths describe CCE output, excluding CLI's final newline or MCP
envelopes. Token estimates and cumulative effect reporting belong to WP20-F.

Writes are best effort. Opening the store and persisting events are lazy; a
failure disables the recorder in that process and never changes the
underlying command/tool response. Rare interrupted writes may leave a
`running` row; the UI labels it an incomplete record, not a live client.
The API status distinguishes no retained requests (`inactive`) from
historically recorded requests (`observed`); neither proves a client is
currently connected. Retention is the store's 30 days/5,000 requests.
