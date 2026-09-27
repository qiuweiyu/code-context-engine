# Roadmap

## Current baseline — v0.1.7

The current open-source baseline is `v0.1.7` at the WP7 acceptance level.

### Delivered core

- [x] Git tracked-file discovery
- [x] local-only indexing
- [x] SQLite + JSONL exports
- [x] Go AST-based function/method extraction
- [x] TypeScript / JavaScript / Vue basic extraction
- [x] call/import dependency extraction
- [x] HTTP route and database-object extraction
- [x] test mapping
- [x] incremental file hashing and parser-version invalidation
- [x] feature freshness: `valid` / `needs_review` / `stale`
- [x] CLI query manifests
- [x] MCP read interface
- [x] typed graph with explicit edge confidence
- [x] bounded forward/reverse graph traversal
- [x] route → handler linking
- [x] frontend request → backend route linking
- [x] page/view → imported API linking
- [x] resolved call traversal across service/repository layers
- [x] database read/write edges
- [x] typed test coverage edges
- [x] cross-surface retrieval through shared graph evidence
- [x] intent-aware final file selection
- [x] Compact LLM query projection for CLI and MCP
- [x] Ubuntu + Windows GitHub CI

### Current typed edge model

Implemented edge types:

- `call`
- `import`
- `route_handler`
- `api_request`
- `db_read`
- `db_write`
- `test_of`
- `page_api`

Implemented confidence levels:

- `exact`
- `static`
- `inferred`
- `unresolved`

Query traversal is bounded and does not continue through unresolved edges.

### WP7 token-efficiency acceptance

Real Student Growth Companion benchmarks preserved selected paths, coverage status and tests while reducing serialized query output by approximately 93% in Compact mode.

The next milestone should improve analyzer precision rather than continue adding retrieval heuristics.

---

## v0.2 — Multi-language analyzer architecture and native language intelligence

### WP8-A — Ground Truth seed baseline (merged)

- [x] start a checked-in fixture, positive/negative typed-edge labels and query relevance
- [x] provide a reproducible runner for labeled Precision/Recall, Top-K/MRR, cold/warm index, query time and output bytes
- [x] add Go interface ambiguity, TS barrel, Vue dual-script, comment false-positive and ambiguous-route cases
- [ ] expand to JS aliases, dynamic imports and real repository ground truth before promoting quality gates

### WP8-B — Internal Language Analyzer Contract (implementation in progress)

- [x] dispatch existing native analyzers through normalized fact output
- [x] internal fact provenance, diagnostics, safe partial-result handling and per-analyzer version invalidation
- [x] wrap existing Go/TS/JS/Vue analyzers; successful query output and ranking stay compatible
- [x] retain schema 8 and existing graph/node IDs; defer public plugin ABI

### WP9 — TS/JS Compiler API and module resolution

- [ ] use Program/TypeChecker, tsconfig/jsconfig alias and package resolution
- [ ] handle re-exports/barrels and JavaScript where possible
- [ ] compare labeled edge quality and index cost with WP8-A

### WP10 — Vue compiler-sfc

- [ ] parse both script blocks, script setup macros and template/component links
- [ ] measure page/API and composable/store results against frozen cases

### WP11 — Go packages and types

- [ ] use go/packages and go/types for cross-package and interface facts
- [ ] preserve AST-only results with explicit provenance when type checking fails

### WP12 — Conditional Go SSA/callgraph pilot

- [ ] attempt only where WP11 benchmarks justify cost
- [ ] separate possible dynamic targets from uniquely established targets

### WP13 — Expanded corpus and quality gates

- [ ] multi-project labeled corpus, edge/query metrics and performance budgets
- [ ] compare parser generations on the same frozen source/configuration

### WP14 — Non-HTTP flows

- [ ] CLI, jobs, consumers and queues, preserving implemented HTTP flows

### WP15 — SCIP, stable schema and public plugin API

- [ ] freeze the external interface after multiple analyzer implementations

### WP16 — IDE / graph visualization; WP17 — Optional semantic providers

- [ ] add editor/visualization integrations after schema stability
- [ ] keep all semantic providers optional and the deterministic core offline

### Future language adapters after the contract is stable

Priority candidates:

1. Java
2. Python
3. C# / C / C++ / Rust
4. Kotlin / PHP / Ruby / Swift / Dart and other ecosystems

Potential native sources include Java compiler/JDT/JavaParser tooling, Python AST plus type-checker data, and Clang/clangd/compile_commands for C/C++.

---

## v0.3 — Automatic feature and non-HTTP flows

Some originally planned v0.3 work was delivered early in WP4–WP6. Remaining work:

- [ ] entry-point registry
- [x] HTTP route → handler → service/repository traversal where static graph evidence resolves the chain
- [x] frontend page/client API → backend route linking for supported analyzers
- [ ] CLI command flows
- [ ] scheduled-job flows
- [ ] event-consumer flows
- [ ] queue publish/consume flows
- [ ] webhook/event flow types where useful
- [ ] feature grouping by route/module conventions
- [ ] automatic flow staleness propagation

---

## v0.4 — Interoperability

- [ ] SCIP export
- [ ] stable public JSON schema
- [ ] public plugin API based on the WP8 analyzer contract
- [ ] editor integration prototype
- [ ] graph visualization export

---

## Quality and scale (baseline begins at WP8-A)

- [x] small checked-in ground-truth seed corpus; expansion remains WP8-A / WP13
- [x] labeled typed-edge precision/recall seed (broader calls/routes/tests coverage pending)
- [x] Top-K / MRR seed (multi-project expansion pending)
- [x] small positive/negative graph edge baseline (expansion pending)
- [ ] large-monorepo incremental benchmark
- [ ] index migration/version compatibility
- [x] Ubuntu CI
- [x] Windows CI
- [ ] macOS CI

Benchmarking must measure both correctness and cost: indexing time, incremental time, query time, selected-file quality and serialized/token-facing output size.

---

## Optional future extensions

Semantic ranking or LLM-assisted providers may be added only as optional plugins. They must never be required for core indexing, graph construction or querying. The deterministic local path remains the default.

## Execution plan

The detailed work-package sequence and machine-resume procedure are documented in:

- [docs/DEVELOPMENT-PLAN.md](docs/DEVELOPMENT-PLAN.md)
- [docs/DEVELOPMENT-PLAN-ZH.md](docs/DEVELOPMENT-PLAN-ZH.md)
