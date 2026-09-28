# WP20-B: local telemetry store

`src/observability/store.js` persists only validated WP20-A events. The SQLite
file is separate from every repository's `.context-index/index.sqlite`.
By default its directory is:

- Linux/macOS: `$XDG_STATE_HOME/cce/telemetry`, or
  `~/.local/state/cce/telemetry`.
- Windows: `%LOCALAPPDATA%\\cce\\telemetry`, or
  `~/AppData/Local/cce/telemetry`.

The database filename is `telemetry.sqlite`. The API may receive an explicit
`directory` for tests and future local configuration. Existing symlink targets
and group/world-accessible directories or database files are rejected on POSIX.
New directories use mode 0700 and the DB uses mode 0600. Windows relies on
the containing user's directory ACLs. SQLite uses WAL, foreign keys, a five
second busy timeout, and a separate schema version (currently 1). A newer or
unknown schema fails closed. No index schema migration is performed.

## API

`openTelemetryStore({directory, retentionDays, maxRequests, now})` returns
`appendEvent`, `listRequests`, `getRequest`, `prune`, `close`, and
`dbPath`. Call `close()` when finished. All writes validate the strict
WP20-A event schema first, then insert atomically. `request_started` creates
the request summary. Later events must match its request ID, trace ID, repo
fingerprint, runtime identity, and transport. The request completion event
updates status and duration. Each request holds at most 128 events.

`listRequests({limit,before})` uses newest-first keyset pagination with an
ISO timestamp and UUID cursor; limit defaults to 50 and cannot exceed 100.
`getRequest(requestId)` returns the request summary plus ordered events,
or null when absent. All timestamps used for ordering are normalized to UTC.
No raw query, path, source, or error text enters the database under v1.

Retention defaults to 30 days and 5000 requests. Inserting a start event and
explicit `prune()` remove older records and those beyond the count limit in
one transaction; the foreign key deletes their events too. Open the store
without collecting any events to inspect existing history, but opening does
not silently apply retention until the next insert or explicit prune.

This package deliberately does not wire CLI/MCP calls to the store. WP20-C
adds a loopback read API. WP20-E adds best-effort runtime adapters and handles
write failures without failing an ordinary CCE query. Token effects and agent
experiment records remain outside this store until their later work packages.
