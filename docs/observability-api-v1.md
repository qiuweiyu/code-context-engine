# WP20-C: local observability read API

Start with `npm run start:observability`. The default address is
`http://127.0.0.1:8765`; set `CCE_OBSERVABILITY_PORT` to an integer
from 0 through 65535 to choose another port (0 asks the OS for a free port).
The process prints its actual URL and runs until SIGINT/SIGTERM. The API
refuses any bind host other than the literal `127.0.0.1`.

The server uses Node's built-in HTTP implementation. It opens the per-user
SQLite telemetry store described in `observability-store-v1.md`; it does not
instrument or activate collection in the MCP or CLI runtime. Start an empty
database and you will see zero stored requests. Only GET is accepted.
Requests with a foreign Host/Origin are rejected; CORS is not enabled.
Responses use `Cache-Control: no-store` and `nosniff`. This is a local
developer interface, not a public or authenticated network service.

## Endpoints

- `GET /status` returns service state, runtime package version/fingerprint,
  telemetry schema version, capture state (`inactive` until WP20-E),
  repository `null`, and index freshness `unavailable`. It does not perform
  an expensive repository freshness scan on each page load.
- `GET /requests?limit=50&cursor=...` returns recent stored request
  summaries with a bounded opaque next cursor. Limit is 1–100; no query
  text, source, DB path, or raw error message is exposed.
- `GET /requests/:id` returns a stored request and its ordered validated
  events, or 404 for an absent UUID.
- `GET /metrics` returns persisted request counts, query counts,
  failures, last request time, and mean duration of successful queries
  for the rolling last 24 hours. It also reports the all-time count of
  retained requests. An empty average is `null`, not zero.
- `GET /effects` reports `status: unavailable` and an empty array until
  WP20-F implements measurement. It makes no token savings claim.

For example, `curl http://127.0.0.1:8765/status` reads the local state.
The API is the stable boundary for WP20-D's UI; the UI does not query SQLite
tables directly. The local homepage at `/` serves the UI shell. WP20-E will connect MCP/CLI request events, including
best-effort writes that never fail an ordinary code query.
