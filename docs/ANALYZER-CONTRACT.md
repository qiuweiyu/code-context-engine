# Internal Language Analyzer Contract (WP8-B)

This is an **internal** boundary, version 1, implemented in `src/context/analyzers.js`. It is not a public plugin ABI. Go remains on the Go AST analyzer; WP9 moves tracked TypeScript/JavaScript to a TypeScript Compiler API analyzer; WP10 moves Vue SFC structure to `@vue/compiler-sfc@3.5.43` while preserving conservative script-level fact extraction. `text-facts` is the fallback for tracked files without a dedicated analyzer, including SQL and future language extensions. WP9 pins `typescript@6.0.3` because the TypeScript 7 line does not currently expose the stable Program/TypeChecker API used by this analyzer.

## Dispatch and facts

`analyzerFor(language)` picks a registered descriptor; its fields are `id`, `languages`, `version`, `evidence`, `capabilities` and `analyze`. The batch `analyze({repoRoot, items, trackedSet})` returns a Map from repository-relative path to raw facts. Supported capabilities are declared at the analyzer level; `heuristic` is never represented as compiler-exact evidence. The current generic text pass supplies heuristic route, client request and database facts for all languages. Test mappings remain a global postprocessing step; they are not a native analyzer capability.

The normalized result for a complete file includes:

- `status: "complete"`, file path/language/content hash and per-analyzer parser version;
- `symbols`, `dependencies` (imports/calls), `routes`, `dbObjects` and optional `tests`;
- optional package name and diagnostics;
- in-memory fact `provenance` with analyzer ID/version, parser version and AST/text-pattern evidence.

The existing schema 8 stores the established symbol/dependency/route/DB columns. Fact provenance is available at normalization time; it is **not yet a persisted public fact schema**. Existing node IDs, edge builders, graph traversal and retrieval ranking stay in place. Graph facts still distinguish `exact`, `static`, `inferred`, and `unresolved` through their established evidence. A language adapter should not claim `exact` merely because it uses an AST. The Vue adapter uses compiler-sfc only for authoritative SFC block structure/locations, analyzes both normal script and script setup against original source offsets, filters compiler macros from project-call evidence, and never treats generated compileScript output as source evidence.

## Failure boundary

An unreadable source, analyzer exception, Go parser error, missing result, malformed fact or declared partial result produces a file-specific diagnostic. That file is not written as a successful empty analysis. Its previous indexed facts remain intact and it is retried at the next index, even if its source hash has not changed. Other successfully analyzed files in the batch can still commit. A failed new file remains absent until repaired.

`index` returns `analysis_failed_files` and `diagnostics`. The latest diagnostics are also stored in SQLite `meta`, shown by `status` and Full query output. When an index has failed files and candidates exist, query coverage becomes `review_required`; Compact includes `analysis_failed_files`. A later successful index clears the warning. This does not prove that old facts reflect the current broken source: callers must inspect the diagnostic before acting on affected files.

## Incremental versions

The existing `files.parser_version` column contains `<global parser version>/contract1/<analyzer ID>@<analyzer version>`. Analyzer-version changes still invalidate only that analyzer's files. WP9 additionally treats TypeScript/JavaScript resolution as cross-file state: a changed script invalidates tracked TS/JS reverse importers transitively, while a new script or a changed/removed `tsconfig`/`jsconfig` invalidates the tracked compiler-script set for that project pass. WP10 reanalyzes Vue files when tracked TS/JS/Vue files are added or removed because relative/module targets can become resolvable without the Vue source changing; normal target-content changes reuse stored imports and the global dependency resolver refreshes the unique target symbol. Warm indexes remain unchanged when hashes, parser versions and repository structure are stable. Changes to the shared route/DB text extractor or normalized contract should still bump the global parser or contract version because they affect multiple languages.

## Adding an analyzer later

Implement a descriptor that returns file-keyed facts; declare truthful capabilities and deterministic versions; validate file ownership and unresolved references; add positive and negative ground-truth examples; test partial/missing results; measure quality and index cost. Preserve language-specific source evidence without adding special cases to traversal/Retriever. Java/Python/C++ analyzers, compiler integration and a stable external plugin API are later work packages.

Run `npm test` and `npm run benchmark` before accepting a change. The WP8-A labeled corpus includes deliberately known misses and false positives; its default runner reports them without failing, while `--strict` is a future quality gate.
