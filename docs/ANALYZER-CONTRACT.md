# Internal Language Analyzer Contract (WP8-B)

This is an **internal** boundary, version 1, implemented in `src/context/analyzers.js`. It is not a public plugin ABI. Existing Go AST, TS/JS regex and Vue script extraction remain the producers. `text-facts` is the fallback for tracked files without a dedicated analyzer, including SQL and future language extensions.

## Dispatch and facts

`analyzerFor(language)` picks a registered descriptor; its fields are `id`, `languages`, `version`, `evidence`, `capabilities` and `analyze`. The batch `analyze({repoRoot, items, trackedSet})` returns a Map from repository-relative path to raw facts. Supported capabilities are declared at the analyzer level; `heuristic` is never represented as compiler-exact evidence. The current generic text pass supplies heuristic route, client request and database facts for all languages. Test mappings remain a global postprocessing step; they are not a native analyzer capability.

The normalized result for a complete file includes:

- `status: "complete"`, file path/language/content hash and per-analyzer parser version;
- `symbols`, `dependencies` (imports/calls), `routes`, `dbObjects` and optional `tests`;
- optional package name and diagnostics;
- in-memory fact `provenance` with analyzer ID/version, parser version and AST/text-pattern evidence.

The existing schema 8 stores the established symbol/dependency/route/DB columns. Fact provenance is available at normalization time; it is **not yet a persisted public fact schema**. Existing node IDs, edge builders, graph traversal and retrieval ranking stay in place. Graph facts still distinguish `exact`, `static`, `inferred`, and `unresolved` through their established evidence. A language adapter should not claim `exact` merely because it uses an AST.

## Failure boundary

An unreadable source, analyzer exception, Go parser error, missing result, malformed fact or declared partial result produces a file-specific diagnostic. That file is not written as a successful empty analysis. Its previous indexed facts remain intact and it is retried at the next index, even if its source hash has not changed. Other successfully analyzed files in the batch can still commit. A failed new file remains absent until repaired.

`index` returns `analysis_failed_files` and `diagnostics`. The latest diagnostics are also stored in SQLite `meta`, shown by `status` and Full query output. When an index has failed files and candidates exist, query coverage becomes `review_required`; Compact includes `analysis_failed_files`. A later successful index clears the warning. This does not prove that old facts reflect the current broken source: callers must inspect the diagnostic before acting on affected files.

## Incremental versions

The existing `files.parser_version` column now contains `<global parser version>/contract1/<analyzer ID>@<analyzer version>`. This causes a **one-time reindex** of old v0.1.7 files when they are next indexed. Afterwards, changing only the Go analyzer version reindexes Go files, not unchanged TS files. Changes to the shared route/DB text extractor or normalized contract should bump the global parser or contract version because they affect multiple languages. Resolver/edge-only changes still need an explicit graph rebuild or force reindex; analyzer-specific versions alone cannot invalidate cross-file graph semantics.

## Adding an analyzer later

Implement a descriptor that returns file-keyed facts; declare truthful capabilities and deterministic versions; validate file ownership and unresolved references; add positive and negative ground-truth examples; test partial/missing results; measure quality and index cost. Preserve language-specific source evidence without adding special cases to traversal/Retriever. Java/Python/C++ analyzers, compiler integration and a stable external plugin API are later work packages.

Run `npm test` and `npm run benchmark` before accepting a change. The WP8-A labeled corpus includes deliberately known misses and false positives; its default runner reports them without failing, while `--strict` is a future quality gate.
