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

### WP8 — Language Analyzer Architecture & Plugin Contract

- [ ] define a stable analyzer interface independent of any one language
- [ ] define analyzer capability metadata such as symbols/imports/calls/types/routes/tests/exact-resolution
- [ ] separate language detection, analyzer dispatch and fact normalization
- [ ] define diagnostics/error boundaries for partial analyzer results
- [ ] define parser/analyzer versioning rules
- [ ] keep current Go / TypeScript / JavaScript / Vue behavior backward compatible
- [ ] document how future Java, Python, C/C++, C#, Rust and other analyzers plug into CCE
- [ ] add contract tests before adding new languages

The core rule is: language adapters produce normalized CCE facts; graph, traversal, retrieval, Compact output and MCP remain language-independent.

### WP9 — TypeScript Compiler API

- [ ] replace/augment regex-only declaration and call analysis with TypeScript Compiler API
- [ ] use `Program` / `TypeChecker` where safe
- [ ] resolve imports, re-exports and symbols with compiler evidence
- [ ] preserve uncertainty when runtime behavior cannot be proven
- [ ] keep JavaScript supported through the same analyzer where possible

### WP10 — Vue compiler-sfc

- [ ] use `@vue/compiler-sfc`
- [ ] reliably parse `<script>` and `<script setup>`
- [ ] support common Vue macros without hand-written source stripping
- [ ] improve component/composable/store/API relationships

### WP11 — TypeScript/JavaScript module resolution

- [ ] tsconfig/jsconfig path aliases
- [ ] package/module resolution
- [ ] barrel/re-export resolution
- [ ] generated-code exclusions appropriate to JS/TS ecosystems

### WP12 — Go native type intelligence

- [ ] Go `go/packages`
- [ ] Go `go/types`
- [ ] package/type-aware interface implementation resolution
- [ ] improve generic and embedded-interface handling
- [ ] preserve existing AST facts as deterministic fallback evidence

### WP13 — Go SSA / callgraph

- [ ] SSA construction where repository configuration permits
- [ ] compiler-backed callgraph evidence
- [ ] distinguish exact/type-resolved edges from heuristic/static edges
- [ ] benchmark interface and dependency-injection-heavy code

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

## v0.5 — Quality, benchmarks and scale

- [ ] checked-in benchmark corpus with ground truth
- [ ] precision/recall evaluation for calls/routes/tests
- [ ] retrieval Top-K / MRR evaluation
- [ ] graph edge correctness evaluation
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
