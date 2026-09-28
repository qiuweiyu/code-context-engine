# Code Context Engine v0.3.0

This GitHub release adds the local observability preview built in WP20-A through WP20-F. The npm package has **not** been published; npm publication is deferred until the release has run stably.

## What is included

- Versioned telemetry contract and local, independently retained request history for CLI and MCP operations.
- Read-only local API and browser UI with Overview, Requests, Effects and Settings.
- Request outcomes, timing, selected-file counts and index events where observed.
- Full/Compact CCE output byte measurements and deterministic token estimates.

## Measurement and privacy

Measured refers to the byte length of CCE's actual Full and Compact outputs. Estimated refers to the deterministic `utf8_bytes_div_4_v1` estimate, rounded up per query before aggregation. Neither measure is an Agent's actual model bill. No without-CCE comparison or Controlled Experiment has been recorded in this release; WP20-G remains future work.

Telemetry stays local, excludes raw query text and source bodies, and does not guess client identity or current index freshness. The read API listens on `127.0.0.1` only. See [measurement details](observability-effects-v1.md) and [UI behavior](observability-ui-v1.md).

## Run from this GitHub release

```bash
git clone --branch v0.3.0 https://github.com/qiuweiyu/code-context-engine.git
cd code-context-engine
npm install --no-package-lock
npm run start:observability
```

Open `http://127.0.0.1:8765/` on the same computer. Run CLI requests or connect the MCP server to populate local request history.

Node.js 22.13+ and Git are required; Go is required for Go-project indexing. See [known limitations](KNOWN-LIMITATIONS.md) for static-analysis boundaries.
