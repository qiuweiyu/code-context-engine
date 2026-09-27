# Changelog

All notable public changes to Code Context Engine are recorded here.

## 0.2.0 — 2026-09-27

First public installable release.

### Added

- deterministic local code indexing for Go, TypeScript, JavaScript and Vue SFC
- typed graph edges for calls, imports, routes, client requests, database access, tests and non-HTTP entry handlers
- bounded forward/reverse graph traversal
- compact query projection shared by CLI and MCP
- Public Index v1
- SCIP export
- Plugin Protocol v1
- public node locate
- self-contained offline graph HTML export
- Optional Semantic Provider Protocol v1 with explicit opt-in bounded reranking

### Quality and release work

- frozen deterministic Ground Truth v6 quality gate: TP=34, FP=1, FN=0
- frozen Semantic Corpus v1 OFF/ON measurement
- Ubuntu and Windows CI
- npm tarball clean-install smoke test
- release package file whitelist
- public Quick Start, release checklist and known-limitations documentation

### Compatibility notes

- Node.js 22.13+ is required
- Git is required
- Go is required only when indexing Go projects
- deterministic retrieval is the default
- Semantic Provider v1 is optional and cannot mutate graph facts or introduce unknown candidate paths
- Public Index v1 and versioned public protocols are the supported interoperability boundary

See [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) for current limits.
