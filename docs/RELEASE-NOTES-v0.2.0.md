# Code Context Engine v0.2.0

v0.2.0 is the first public installable CCE release.

CCE builds a local, queryable code map from a Git repository without requiring an LLM or source upload.

## Highlights

- Go, TypeScript, JavaScript and Vue SFC static analysis
- package/module-aware resolution where supported
- HTTP, database, tests and non-HTTP entry-flow evidence
- typed graph traversal and compact task-oriented retrieval
- CLI and MCP surfaces
- Public Index v1 and SCIP export
- source locate and offline graph HTML
- Optional Semantic Provider v1 with explicit bounded reranking

## Install

```bash
npm install -g code-context-engine
cce --help
```

Requirements:

- Node.js 22.13+
- Git
- Go only for Go-project indexing

## Quality gates

Deterministic Ground Truth v6:

- TP 34
- FP 1
- FN 0
- compact bytes 6243

Semantic Corpus v1:

- Hit@5: 3/5 OFF → 5/5 ON
- MRR: 0.1567 OFF → 0.4567 ON

## Important boundaries

CCE is a static-analysis tool and deliberately leaves ambiguous runtime behavior unresolved.

Semantic Provider v1 is optional. It may rerank only deterministic candidates and cannot create graph facts, alter confidence or inject unknown paths.

Public Index v1, SCIP and versioned public protocols are the supported external integration boundary. Internal SQLite layout is not a public API.

See:

- [Quick Start](QUICKSTART.md)
- [Known limitations](KNOWN-LIMITATIONS.md)
- [Semantic Provider v1](SEMANTIC-PROVIDER.md)
- [Interoperability](INTEROPERABILITY.md)
