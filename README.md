# Code Context Engine

[English](README.md) | [中文](README-ZH.md)

**Turn a local codebase into a queryable code map — no LLM, no cloud, no source upload.**

Code Context Engine (CCE) is a local-first static analysis tool that builds a structured knowledge index for a repository. It extracts files, functions and methods, signatures, comments, call/import edges, routes, database objects, tests, and feature references, then exposes that information through a CLI and MCP server.

CCE is designed for both humans and coding agents. The core indexing path is deterministic and does not require an AI model or external API.

**Quick Start:** [docs/QUICKSTART.md](docs/QUICKSTART.md) · [中文快速开始](docs/QUICKSTART-ZH.md) · [Known limitations](docs/KNOWN-LIMITATIONS.md) · [Changelog](CHANGELOG.md) · [Interoperability v1](docs/INTEROPERABILITY.md)


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

`v0.3.0` is the GitHub-only observability preview. npm publication is deferred; `v0.2.0` was the first GitHub release.

Implemented today:

- Go — AST plus `go/packages` / `go/types` evidence for package-aware functions, methods, generics and conservative interface resolution.
- TypeScript / JavaScript — compiler-backed module resolution, tsconfig/jsconfig paths, re-exports, imports and conservative call facts.
- Vue SFC — `@vue/compiler-sfc` parsing for normal script + `script setup`, component/composable evidence and TS/JS analysis.
- HTTP, SQL, CLI, scheduled-job and consumer entry facts with typed graph traversal.
- Tests — conservative mappings plus typed `test_of` edges.
- Typed graph — calls, imports, routes, client requests, database access, tests, page/API links and non-HTTP entry handlers.
- Edge confidence — `exact`, `static`, `inferred`, `unresolved`.
- Bounded forward/reverse graph traversal without traversing unresolved edges.
- Cross-surface retrieval with compact CLI/MCP output for coding agents.
- Public Index v1, SCIP export and Plugin Protocol v1.
- Public node locate and self-contained offline graph HTML export.
- Optional Semantic Provider v1 — explicit opt-in bounded reranking; deterministic retrieval remains the default and authoritative fact source.

The frozen deterministic quality corpus currently passes at TP=34, FP=1, FN=0. The separate Semantic Corpus v1 demonstrates measurable reranking benefit on five paraphrase cases without changing graph facts.

CCE is not limited by design to Go/TypeScript/JavaScript/Vue, but Java, Python, C/C++, C#, Rust and other analyzers are future work rather than supported v0.2.0 analyzers.

## What it generates

Running an index creates `.context-index/` inside the target repository:

```text
.context-index/
├── index.sqlite
├── manifest.json
├── files.jsonl
├── symbols.jsonl
├── features.jsonl
├── entry-points.jsonl
├── routes.jsonl
├── tables.jsonl
├── tests.jsonl
├── dependencies.jsonl
└── changes.jsonl
```

Example symbol record:

```json
{
  "symbol_id": "go:internal/task/service.go::*Service.UpdateManualTask",
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
- Go, only when indexing Go projects

## Install

For the current GitHub release:

```bash
git clone --branch v0.3.0 https://github.com/qiuweiyu/code-context-engine.git
cd code-context-engine
npm install --no-package-lock
npm run start:observability
```

Open `http://127.0.0.1:8765/` on the same machine. npm publication is deferred until this GitHub release has run stably. See the [v0.3.0 release notes](docs/RELEASE-NOTES-v0.3.0.md).

After the npm release is published:

```bash
npm install -g code-context-engine
cce --help
```

You can also run the package without a global install:

```bash
npx code-context-engine --help
```

Source checkout remains supported for contributors:

```bash
git clone https://github.com/qiuweiyu/code-context-engine.git
cd code-context-engine
npm install
npm test
```

## CLI

Index a repository:

```bash
cce index --repo /path/to/project
```

Query the generated knowledge index:

```bash
cce query \
  --repo /path/to/project \
  --task "edit an unpublished manual task"
```

For ChatGPT, Codex, or another coding agent, request the compact LLM view:

```bash
cce query \
  --repo /path/to/project \
  --task "edit an unpublished manual task" \
  --compact
```

Without `--compact`, the full diagnostic output remains available.

Inspect freshness:

```bash
cce status --repo /path/to/project
```

Force a full rebuild only when explicitly needed:

```bash
cce index --repo /path/to/project --force
```


## Cross-language query aliases

CCE does not use an LLM to translate task descriptions. Query-time retrieval includes a small built-in developer vocabulary and supports project-specific aliases in `.context-query-aliases.json`.

Example:

```json
{
  "定向任务": ["manualtask", "manual_task"],
  "宠物成长": ["petgrowth", "pet_growth"]
}
```

Aliases affect querying only; changing them does not require re-indexing.

## Typed graph retrieval

Task queries do more than lexical ranking. After deterministic alias/keyword matching finds a small set of entry points, CCE expands through a bounded typed graph built from static source evidence.

Current edge types used by query/flow traversal include:

- `page_api` — page/view to an imported API function that is actually called,
- `api_request` — client request to a matching server route,
- `route_handler` — server route to handler,
- `call` — resolved symbol call,
- `db_read` / `db_write` — symbol to database object,
- `test_of` — test to production target.

Query traversal uses static-confidence edges, is bounded to at most 6 hops, and does not traverse unresolved links. This lets a business task bridge layers such as page → API → route → handler → service → repository → database, and also walk reverse evidence back toward alternate clients or tests.

If a task explicitly names multiple code surfaces such as an admin UI and a miniprogram, final selection reserves a small bounded number of slots for graph-discovered files that match those explicit path intents so one surface cannot crowd the other out.

## Optional Semantic Provider v1

Semantic refinement is explicit opt-in. The deterministic retriever always creates the candidate set first; a provider can only rerank that bounded set and cannot add graph facts, change edge confidence or introduce unknown paths.

Example:

```bash
cce query \
  --repo /path/to/project \
  --task "find where homework is assigned" \
  --semantic-provider /path/to/provider.json
```

Provider failures, timeouts or invalid responses fall back to the deterministic result. CCE-owned provider requests do not include source-file bodies. See [docs/SEMANTIC-PROVIDER.md](docs/SEMANTIC-PROVIDER.md).

## MCP

CCE also exposes the local index as a read-oriented MCP server.

Tools:

- `context_index_repo`
- `context_query`
- `context_index_status`

The MCP server has no model dependency. It reads only repositories under `CCE_ALLOWED_ROOTS`. The `context_query` tool accepts optional `compact: true` and explicit in-repository `semantic_provider`.

Example after global npm installation:

```bash
export CCE_ALLOWED_ROOTS=/home/me/projects
code-context-engine-mcp
```

## Local observability UI (preview)

Run `npm run start:observability` and open `http://127.0.0.1:8765/` on the same machine. The UI shows runtime status, saved request traces, effects provenance, and local settings. Real MCP/CLI index, status and query calls are recorded locally without saving raw task text or source. Empty history means no retained calls have been observed; recorded history does not prove a client is online. The Effects page distinguishes measured CCE output bytes from deterministic token estimates; it does not claim actual Agent savings. See [UI](docs/observability-ui-v1.md) and [measurement method](docs/observability-effects-v1.md). Controlled Agent comparisons are planned in [WP20-G](docs/observability-agent-experiment-v1.md); no paired Agent runs have been recorded.

## Query result

A query has two output views. The default Full view keeps retrieval and graph diagnostics for engine inspection. `--compact` (or MCP `compact: true`) projects that same result into an LLM-oriented view containing coverage, selected files, bounded symbol hints, and tests. Compact mode does not run a different retrieval path.

The default Full view includes diagnostics such as:

```json
{
  "query_expansion": {
    "graph_seed_nodes": ["symbol:go:internal/task/service.go::*Service.UpdateManualTask"]
  },
  "graph_expansion": {
    "added_files": 4,
    "forward_steps": 8,
    "reverse_steps": 6
  },
  "selection": {
    "intent_reserved_files": []
  },
  "must_read": [
    {
      "path": "internal/task/service.go",
      "reasons": ["symbol_match"],
      "symbols": ["go:internal/task/service.go::*Service.UpdateManualTask"]
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
- the deterministic core makes no network requests.
- Semantic Provider v1 is never auto-enabled; a user-configured provider is a separate process with its own trust/network boundary.

Static analysis output can still reveal project structure. Treat exported index files according to the sensitivity of the source repository.

## Known limitations

CCE v0.2.0 does not claim full runtime reconstruction and does not yet provide first-class Java, Python, C/C++, C# or Rust analyzers. Dynamic dispatch, reflection, generated/configuration-driven wiring and unsupported framework registrations may remain unresolved. Semantic Provider v1 can rerank only deterministic candidates; it cannot recover a file that never entered that bounded candidate set.

See [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) for the full release boundary.

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
Typed edge graph + dependency resolution
     ↓
Bounded query / flow traversal
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

The detailed post-WP7 execution sequence is in [docs/DEVELOPMENT-PLAN.md](docs/DEVELOPMENT-PLAN.md).

Near-term priorities:

1. Language Analyzer Architecture & Plugin Contract.
2. TypeScript Compiler API integration.
3. Vue compiler-sfc integration.
4. TypeScript/JavaScript module and path-alias resolution.
5. Go `go/packages` + `go/types`, followed by SSA/callgraph.
6. Ground-truth benchmark corpus and precision/recall/retrieval metrics.
7. Java and Python adapters after the analyzer contract is stable.
8. Public Index v1, SCIP export and Plugin Protocol v1 landed in WP15; WP16 adds Public Index-based editor locate and offline graph visualization prototypes.
9. Optional semantic providers as plugins — never required by the core engine.

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

## Analyzer quality baseline

Run `npm run benchmark` to inspect labeled graph edges, query relevance and indexing cost. The frozen corpus keeps one explicitly labeled comment/text-pattern false positive; see [benchmark guide](docs/BENCHMARKS.md).

Internal analyzer boundary: [contract](docs/ANALYZER-CONTRACT.md).
