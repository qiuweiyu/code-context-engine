# Architecture

## Goal

Code Context Engine builds a deterministic, refreshable, language-extensible knowledge layer over a local repository.

The engine separates **source facts** from **human business semantics**, and separates **language-specific analysis** from **language-independent graph/query behavior**.

## Current architecture

```text
Git tracked files
      ↓
Safety filter
      ↓
Language detection
      ↓
Language analyzers
      ↓
Normalized source facts
      ↓
SQLite transaction
      ↓
Dependency / route / data / test resolution
      ↓
Typed edge graph
      ↓
Bounded forward/reverse traversal
      ↓
Task retrieval + cross-surface selection
      ↓
Full diagnostics / Compact LLM projection
      ↓
CLI / MCP
```

## Source facts

Generated from code and never manually maintained as business truth:

- files and languages,
- symbols,
- method/function signatures,
- parameters and return types,
- comments,
- line ranges,
- imports,
- call references,
- HTTP routes,
- client requests,
- database objects,
- test mappings,
- content / implementation / semantic hashes.

## Business semantics

Optional, human-reviewed data that static analysis cannot always know:

- feature names,
- business intent,
- business invariants,
- ordered feature steps.

Feature steps reference source symbols by `symbol_id`. Exported feature views resolve current source facts from the index.

## Typed graph

CCE currently persists typed edges in schema version 8.

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

- `exact` — compiler/type-system or equivalent exact evidence when available,
- `static` — syntactically/static-analysis resolved with high confidence,
- `inferred` — convention or heuristic based,
- `unresolved` — a reference was observed but its target is not proven.

CCE surfaces uncertainty instead of silently presenting inferred runtime behavior as fact.

Current query traversal uses bounded graph expansion, can walk forward and reverse evidence, supports at most 6 hops, and does not continue through unresolved links. Width/node limits prevent a high-fanout node from exploding query context.

## Cross-surface retrieval

The graph can bridge supported application surfaces when static evidence connects them. Typical supported chains include:

```text
Page / View
   ↓ page_api
Client API function
   ↓ api_request
HTTP Route
   ↓ route_handler
Handler
   ↓ call
Service
   ↓ call
Repository
   ↓ db_read / db_write
Database object
```

Reverse traversal can recover alternate clients, callers and related tests. Shared database evidence can also seed cross-surface retrieval when differently named code paths converge on the same data object.

This is static analysis, not proof of every runtime edge. Reflection, dynamic dispatch, configuration-driven wiring, generated code and runtime registration can remain incomplete.

## Query and Compact projection

Task retrieval combines deterministic query expansion, project aliases, lexical evidence and typed-graph expansion.

The default Full output retains retrieval/graph diagnostics. Compact mode projects the same retrieval result into a smaller LLM-oriented shape. Compact mode does **not** execute a different ranking or graph path.

WP7 real-project acceptance reduced serialized query output by roughly 93% across three Student Growth Companion benchmarks while preserving selected paths, coverage status and tests.

## Incremental indexing

Every indexed file stores a content hash and a version scoped to its analyzer (plus the global/contract version).

A file is skipped when both are unchanged.

When a file changes, CCE:

1. records old symbols,
2. reparses the changed file,
3. replaces its source facts,
4. compares old/new symbol implementation and semantic hashes,
5. marks dependent features `needs_review`,
6. marks unresolved feature references `stale`,
7. resolves dependencies, routes, tests and typed edges,
8. regenerates exported structure files.

Edge construction may depend on facts from multiple files. When resolver/edge semantics change, a force rebuild or parser/schema version change may be required even when source file hashes are unchanged.

## Symbol identity

A symbol ID must be deterministic within a repository and stable when the logical symbol has not changed.

Current examples:

```text
go:internal/task/service.go::*Service.UpdateManualTask
typescript:admin/src/task.ts::updateManualTask
```

Go symbol IDs include source paths so platform/build-tag variants with identical receiver/method names remain distinct. Symbol identity changes must be conservative because feature freshness and graph references depend on them.

## Language analyzer boundary

### Current analyzers

#### Go

Current Go parsing uses Go AST tooling through a helper process. It already extracts package-aware function/method facts and records conservative receiver/receiver-field call metadata that the resolver can use for interface/concrete-field call edges.

It is **not yet** a full compiler/type-system callgraph. Planned native upgrades:

- `go/packages`,
- `go/types`,
- SSA,
- callgraph,
- stronger interface/generic resolution.

#### TypeScript / JavaScript / Vue

The current analyzer extracts common declarations, imports and calls conservatively. Vue SFC source is currently reduced to script content before TS/JS analysis.

Planned native upgrades:

- TypeScript Compiler API `Program` + `TypeChecker`,
- Vue `@vue/compiler-sfc`,
- tsconfig/jsconfig path aliases,
- re-export/module resolution,
- component/store/composable/API relationships.

### Multi-language direction

CCE is not intended to be limited to Go, TypeScript, JavaScript or Vue.

WP8-B implements an **internal Language Analyzer Contract** in `src/context/analyzers.js`. It dispatches current parsers and normalizes compiler/parser or text evidence into file-keyed facts, with capabilities, per-analyzer versions and diagnostics. It is not yet a stable third-party plugin API. The graph, traversal and ranking still consume the established schema 8 facts. See [the contract](docs/ANALYZER-CONTRACT.md).

Conceptually:

```text
Go analyzer ─────────┐
TS/JS/Vue analyzer ──┤
Java analyzer ───────┤
Python analyzer ─────┤ → Normalized CCE facts → Typed graph → Retrieval → MCP/CLI
Clang analyzer ──────┘
```

The internal contract defines capability metadata, analyzer versions, diagnostics, partial-result handling and normalized in-memory facts. On parse failure the previous facts are retained and status/query surfaces report the diagnostic; repaired files retry automatically. External stable fact persistence and plugin ABI remain future work. New languages should use adapters rather than add conditions in graph/retrieval code.

Likely future adapters include Java, Python, C/C++, C#, Rust and additional ecosystems.

## Storage

SQLite is the query database. JSONL files are transparent exports for inspection, diffing and interoperability.

Generated `.context-index` data is disposable and can always be rebuilt from source plus optional `.context-features` definitions.

## Security boundary

Source discovery is restricted to tracked source files after safety filtering. Sensitive file patterns are excluded, symlinks are not followed when reading repository source, and MCP repository access is constrained by `CCE_ALLOWED_ROOTS`.

The core engine does not require network access or an AI model.

## MCP boundary

MCP is an adapter over the local engine, not the engine itself.

The core indexing/query modules remain usable without MCP or any AI system. MCP exposes repository indexing/status/query operations while preserving the same deterministic core and optional Compact projection.

## Development direction

The immediate priority after WP8-B is to compare TypeScript Compiler API, Vue compiler-sfc and Go type evidence against the WP8-A quality baseline. More languages follow proven adapters and measured quality, rather than a public ABI frozen before compiler integrations.

See [ROADMAP.md](ROADMAP.md) and [docs/DEVELOPMENT-PLAN.md](docs/DEVELOPMENT-PLAN.md).
