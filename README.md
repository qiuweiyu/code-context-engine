# Code Context Engine

[English](README.md) | [中文](README-ZH.md)

**Turn a local codebase into a queryable code map — no LLM, no cloud, no source upload.**

Code Context Engine (CCE) is a local-first static analysis tool that builds a structured knowledge index for a repository. It extracts files, functions and methods, signatures, comments, call/import edges, routes, database objects, tests, and feature references, then exposes that information through a CLI and MCP server.

CCE is designed for both humans and coding agents. The core indexing path is deterministic and does not require an AI model or external API.


## Why

Large repositories are expensive to understand repeatedly. Developers and coding agents often spend most of their time rediscovering:

- where a method lives,
- who calls it,
- what it calls,
- which route reaches it,
- which database object it touches,
- which tests cover it,
- and which files belong to the same feature flow.

CCE turns those facts into a local machine-readable index that can be refreshed incrementally as the code changes.

## Principles

- **Local-first** — source code stays on the machine.
- **No LLM required** — indexing and retrieval are deterministic code operations.
- **Incremental** — unchanged files are skipped by content hash.
- **Freshness-aware** — method changes invalidate dependent feature metadata.
- **Evidence-first** — file paths, line ranges, signatures and call edges come from source analysis.
- **Agent-ready** — compact context manifests can be consumed by Codex, Claude Code, ChatGPT, Cursor, IDEs or CI.
- **Honest about uncertainty** — static analysis cannot prove every runtime edge in systems that use reflection, dynamic dispatch or configuration-driven wiring.

## Current status

`v0.1.0` is an early open-source baseline.

Current deep analyzers:

- Go — AST-based function/method extraction, signatures, comments, calls and imports.
- TypeScript / JavaScript — function extraction, imports and call references.
- Vue SFC — script/script-setup extraction plus TypeScript/JavaScript analysis.
- SQL and HTTP route detection — lightweight deterministic extraction.
- Tests — filename and call-based mappings.

The TypeScript/Vue analyzer is intentionally conservative in v0.1 and will move to TypeScript Compiler API + Vue compiler-sfc in a later milestone.

## What it generates

Running an index creates `.context-index/` inside the target repository:

```text
.context-index/
├── index.sqlite
├── manifest.json
├── files.jsonl
├── symbols.jsonl
├── features.jsonl
├── routes.jsonl
├── tables.jsonl
├── tests.jsonl
├── dependencies.jsonl
└── changes.jsonl
```

Example symbol record:

```json
{
  "symbol_id": "go:internal/task::*Service.UpdateManualTask",
  "file_path": "internal/task/service.go",
  "name": "UpdateManualTask",
  "qualified_name": "*Service.UpdateManualTask",
  "kind": "method",
  "signature": "func(ctx context.Context, taskID int64, input UpdateInput) error",
  "params": [
    { "name": "ctx", "type": "context.Context" },
    { "name": "taskID", "type": "int64" },
    { "name": "input", "type": "UpdateInput" }
  ],
  "returns": [{ "name": "", "type": "error" }],
  "file": "internal/task/service.go",
  "lines": [182, 246]
}
```

## Feature freshness

CCE treats source code as the source of truth.

Feature definitions may reference stable `symbol_id` values. CCE never copies method parameters or file locations into the feature definition as authoritative data. Instead, it resolves them from the current symbol index when exporting.

When code changes:

```text
file hash changes
    ↓
file is re-indexed
    ↓
symbol implementation_hash / semantic_hash changes
    ↓
dependent feature becomes needs_review
```

If a referenced symbol is renamed or removed:

```text
feature status → stale
```

A stale feature should not be treated as reliable context until the reference is repaired.

## Requirements

- Node.js 22.13+
- Git
- Go, when indexing Go projects

## Install from source

```bash
git clone https://github.com/qiuweiyu/code-context-engine.git
cd code-context-engine
npm install
```

## CLI

Index a repository:

```bash
node src/cli.js index --repo /path/to/project
```

Query the generated knowledge index:

```bash
node src/cli.js query \
  --repo /path/to/project \
  --task "edit an unpublished manual task"
```

Inspect freshness:

```bash
node src/cli.js status --repo /path/to/project
```

Force a full rebuild:

```bash
node src/cli.js index --repo /path/to/project --force
```

## MCP

CCE also exposes the local index as a read-oriented MCP server.

Tools:

- `context_index_repo`
- `context_query`
- `context_index_status`

The MCP server has no model dependency. It reads only repositories under `CCE_ALLOWED_ROOTS`.

Example:

```bash
export CCE_ALLOWED_ROOTS=/home/me/projects
node src/server.js
```

## Query result

A task query returns a compact manifest instead of dumping the whole repository:

```json
{
  "features": [],
  "must_read": [
    {
      "path": "internal/task/service.go",
      "symbols": ["go:internal/task::*Service.UpdateManualTask"]
    }
  ],
  "maybe_read": [],
  "tests": ["internal/task/service_test.go"],
  "coverage": {
    "status": "sufficient"
  }
}
```

This can be handed to a human or a coding agent, which then reads the real source for the selected files and symbols.

## Optional feature definitions

Repositories can add human-reviewed business semantics under `.context-features/*.json`.

These definitions should contain only information static analysis cannot reliably infer, such as:

- feature name,
- business purpose,
- ordered business steps,
- invariants,
- references to source `symbol_id` values.

Source facts such as method parameters, line numbers and file paths remain generated from code.

## Security model

CCE is designed to avoid accidental secret ingestion:

- `.env`, private keys, certificates, common credential files and lockfiles are excluded from source indexing.
- symlinks are not followed when reading repository source.
- MCP access is limited by `CCE_ALLOWED_ROOTS`.
- the core engine makes no network requests.

Static analysis output can still reveal project structure. Treat exported index files according to the sensitivity of the source repository.

## Architecture

```text
Git repository
     ↓
tracked files
     ↓
Language analyzers
     ↓
Symbol / Route / Data / Test facts
     ↓
Dependency resolution
     ↓
Feature freshness propagation
     ↓
SQLite + JSONL index
     ↓
CLI / MCP / future IDE integrations
```

See [ARCHITECTURE.md](ARCHITECTURE.md).

## Roadmap

See [ROADMAP.md](ROADMAP.md).

Near-term priorities:

1. TypeScript Compiler API integration.
2. Vue compiler-sfc integration.
3. Automatic entry-point and feature-flow discovery.
4. Better call graph confidence/evidence labels.
5. SCIP export.
6. Benchmark corpus for index correctness and incremental performance.
7. Optional semantic providers as plugins — never required by the core engine.

## Non-goals

CCE is not:

- a code-generating LLM,
- a replacement for compiler/runtime tests,
- proof of dynamic runtime behavior,
- a hosted source-code service.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
