# CCE Interoperability v1

WP15 adds three external interoperability surfaces without freezing CCE's internal SQLite schema or analyzer implementation.

## Public Index v1

Every successful index writes a stable graph export under:

`.context-index/public/v1/`

Files:

- `manifest.json`
- `nodes.jsonl`
- `edges.jsonl`

The public format is `cce-public-index` version `1.0.0`.

Compatibility rules for major version 1:

- additive fields are allowed and readers must ignore unknown fields;
- existing field removal or semantic changes require a new major version;
- internal SQLite schema versions are producer metadata only and are not the public compatibility contract;
- public edge IDs are derived from stable public edge content and do not expose internal SQLite source row IDs.

### Migration from internal exports

Consumers that previously read internal files such as `symbols.jsonl`, `routes.jsonl`, or SQLite tables should migrate to `public/v1/nodes.jsonl` and `public/v1/edges.jsonl`.

Example:

```text
old internal dependency
  symbols.symbol_id
  edges.source_id
  routes.handler_symbol_id

public v1
  node.id = "symbol:<symbol-id>"
  edge.from / edge.to
  edge.type / confidence / evidence
```

Do not key external integrations to the internal schema number. Read `manifest.format` and `manifest.version` instead.

## SCIP export

SCIP is an adapter over Public Index v1, not CCE's canonical graph model.

After indexing:

```bash
node src/cli.js export-scip --repo /path/to/repo --out /path/to/index.scip
```

Optional repository identity:

```bash
node src/cli.js export-scip --repo /path/to/repo --out ./index.scip --repository my-repo
```

The exporter uses the official Go SCIP bindings pinned to `github.com/scip-code/scip/bindings/go/scip v0.9.0`.

Current scope:

- emits SCIP `SymbolInformation` for indexed symbols;
- emits a definition `Occurrence` only when CCE can prove a unique identifier byte range on the indexed definition line;
- does not synthesize call/reference occurrences because CCE's existing graph facts do not yet retain source ranges for those references;
- export is explicit and is not run automatically during indexing.

## Plugin Protocol v1

`src/plugin/v1.js` defines a process-neutral JSON protocol:

- protocol: `cce-analyzer`
- protocol version: `1`
- fact version: `1.0.0`

A descriptor declares plugin ID, plugin version, languages and capabilities. Analyze requests contain repository-relative files and tracked-file paths. Results contain per-file status, symbols, import/call dependencies and diagnostics.

WP15 deliberately does **not** discover or execute plugin commands from a repository. There is no plugin manifest auto-run path. A future execution layer must require explicit user configuration/authorization and must preserve path and fact validation.

Compatibility rules:

- unknown additive fields are allowed;
- incompatible protocol/fact versions are rejected;
- paths must stay repository-relative;
- duplicate file results and duplicate symbol IDs within a file are rejected;
- unsupported dependency relation types are rejected.

## Verification

Run:

```bash
npm test
npm run benchmark:gate
cd internal/scipexporter && go test ./... && go vet ./...
```

The WP15 compatibility tests cover Public Index determinism/additive fields, Plugin Protocol valid/invalid messages, and SCIP encode/decode round-trip.
