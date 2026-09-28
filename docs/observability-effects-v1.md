# WP20-F: CCE output effects

Run `npm run start:observability` and open the local Effects page, or read
`GET /effects`. Data comes only from retained successful `query` requests
with an explicitly measured `query_completed` event. Failed, unfinished,
unmeasured legacy and non-query requests do not contribute to the totals.
`query_counts` shows successful, measured and unmeasured counts. The
`scope: retained_history` window is bounded by local storage retention
(default 30 days and 5,000 requests); totals can decrease as events expire.

Each recorded query has two internally generated CCE JSON projections:
Full and Compact. Their serialized UTF-8 byte lengths are actual measurements
of CCE output, excluding the CLI newline and MCP envelope. A reduction in
these bytes does not establish a reduction in a model's consumed tokens or
in an Agent's later file reads. `GET /requests/:id` exposes derived
`effects` for eligible requests; older traces without explicit byte
provenance and failed requests return `effects: []`.

`utf8_bytes_div_4_v1` is a fixed, deterministic **estimate**:
`ceil(full_bytes / 4)` and `ceil(compact_bytes / 4)` for each request,
then add the per-request estimates. It is not a model tokenizer or billing
record; different models and languages may diverge substantially. Estimated
tokens are derived at read time from the measured event, without changing the
event or SQLite schema. The API labels each measurement `measured` or
`estimated` and exposes the method. The UI computes a signed difference
`Full - Compact`: negative means Compact grew, zero means no difference.
Percent is the signed difference divided by Full when Full is positive.

`controlled_experiment.status` remains `unavailable`: CCE has no Agent
subsequent-read adapter or same-task-without-CCE baseline yet. These output
comparisons must not be described as actual Agent token savings. WP20-G
will collect those comparisons separately. No source body, raw task, result
path, credential or outbound upload is needed for these metrics.
