# WP20-D: local observability UI

Run `npm run start:observability` from the CCE repository and open
`http://127.0.0.1:8765/` on the same machine. The address printed by the
process is authoritative if `CCE_OBSERVABILITY_PORT` is set. The UI is
served by the existing loopback API; it adds no cloud service, frontend
build step, or third-party browser runtime. It ships as a small HTML/CSS/
JavaScript shell under `src/observability/ui/`.

## Pages

- **Overview** separates the local API's availability from MCP client
  activity. Runtime version/HEAD and retained 24-hour request metrics come
  from `/status` and `/metrics`. Index freshness and active repository
  are marked unavailable until actually observed.
- **Requests** uses the bounded `/requests` cursor, followed by
  `/requests/:id` for a chronological event drawer. It shows only fields
  stored by the current privacy contract; original task and selected file
  paths are explicitly unavailable.
- **Effects** compares measured Full/Compact CCE output bytes and separately
  estimated tokens over retained, successful measured queries. It reports
  exclusions, displays increases as increases, and keeps Controlled
  Experiment unavailable until real Agent comparisons exist.
- **Settings** shows observed listening address, runtime version,
  retention days and maximum requests. Editing controls are deferred
  until a writable configuration contract exists. The DB path is hidden.

The interface refreshes service status and 24-hour metrics every 20 seconds.
Requests can be refreshed or paged manually. On API failures it displays
unavailable/offline, rather than retaining values as if they were current.
The UI uses same-origin assets, a restrictive Content Security Policy,
no-store responses, and no external fonts or scripts. Narrow screens expose
all four navigation items without sideways scrolling.

WP20-D is a read-only shell. WP20-E records real MCP/CLI index/status/query
operations in the per-user store. Stored requests prove historical activity,
not that an MCP client is connected right now. The privacy contract does not
retain raw task text or file paths. WP20-F derives aggregate Measured byte
comparisons and Estimated token values from trace bytes without modifying the
SQLite schema. See `observability-effects-v1.md` for limits and formulas.
