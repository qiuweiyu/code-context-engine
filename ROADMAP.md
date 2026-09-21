# Roadmap

## v0.1 — Open-source baseline

- [x] Git tracked-file discovery
- [x] local-only indexing
- [x] SQLite + JSONL exports
- [x] Go function/method extraction
- [x] TypeScript/JavaScript/Vue basic extraction
- [x] call/import edges
- [x] route/data-object extraction
- [x] test mapping
- [x] incremental file hashing
- [x] feature freshness: valid / needs_review / stale
- [x] CLI query manifests
- [x] MCP read interface

## v0.2 — Native language intelligence

- [ ] Go `go/packages` + `go/types`
- [ ] Go SSA/callgraph
- [ ] TypeScript Compiler API
- [ ] Vue compiler-sfc
- [ ] tsconfig path aliases
- [ ] evidence/confidence on dependency edges
- [ ] robust generated-code exclusions

## v0.3 — Automatic feature flows

- [ ] entry-point registry
- [ ] HTTP route → handler → service → repository traversal
- [ ] frontend component → client API → backend route linking
- [ ] CLI command flows
- [ ] scheduled-job flows
- [ ] event-consumer flows
- [ ] feature grouping by route/module conventions
- [ ] automatic flow staleness propagation

## v0.4 — Interoperability

- [ ] SCIP export
- [ ] stable JSON schema
- [ ] plugin API for language analyzers
- [ ] editor integration prototype
- [ ] graph visualization export

## v0.5 — Quality and scale

- [ ] benchmark repositories
- [ ] precision/recall evaluation for calls/routes/tests
- [ ] large-monorepo incremental benchmark
- [ ] index migration/version compatibility
- [ ] Windows/Linux/macOS CI matrix

## Optional future extensions

Semantic ranking providers may be added as optional plugins. They must never be required for core indexing or querying, and the local deterministic path remains the default.
