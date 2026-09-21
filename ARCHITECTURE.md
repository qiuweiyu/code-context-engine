# Architecture

## Goal

Code Context Engine builds a deterministic, refreshable knowledge layer over a local repository.

The engine separates **source facts** from **human business semantics**.

### Source facts

Generated from code and never manually maintained:

- files and languages,
- symbols,
- method/function signatures,
- parameters and return types,
- comments,
- line ranges,
- imports,
- call references,
- HTTP routes,
- database objects,
- test mappings,
- content / implementation / semantic hashes.

### Business semantics

Optional, human-reviewed data that static analysis cannot always know:

- feature names,
- business intent,
- business invariants,
- ordered feature steps.

Feature steps reference source symbols by `symbol_id`. Exported feature views resolve the current source facts from the index.

## Pipeline

```text
Git tracked files
      ↓
Safety filter
      ↓
Language detection
      ↓
Language analyzers
      ↓
Facts per file
      ↓
SQLite transaction
      ↓
Dependency resolution
      ↓
Test mapping
      ↓
Feature freshness propagation
      ↓
JSONL / manifest export
```

## Incremental indexing

Every indexed file stores a content hash and parser version.

A file is skipped when both are unchanged.

When a file changes, CCE:

1. records the old symbols,
2. reparses the changed file,
3. replaces its source facts,
4. compares old/new symbol implementation and semantic hashes,
5. marks dependent features `needs_review`,
6. marks unresolved references `stale`,
7. resolves dependencies and tests,
8. regenerates exported structure files.

## Symbol identity

A symbol ID must be deterministic within a repository and stable when the symbol itself has not been renamed or moved in a way that changes its logical identity.

Current examples:

```text
go:internal/task/service.go::*Service.UpdateManualTask
typescript:admin/src/task.ts::updateManualTask
```

Go symbol IDs include the source file path so platform/build-tag variants with the same receiver and method name remain distinct. The symbol identity strategy will evolve carefully because feature freshness depends on it.

## Confidence and evidence

Not all relationships are equally certain.

Future schemas should distinguish edges such as:

- `exact` — compiler/type-system resolved,
- `static` — syntactically resolved with high confidence,
- `inferred` — convention or heuristic based,
- `unresolved` — reference observed but destination unknown.

CCE should surface uncertainty instead of silently presenting inferred runtime behavior as fact.

## Language analyzers

### Go

Current Go parsing uses Go AST tooling through a small helper process.

Planned deep analysis:

- `go/packages`,
- `go/types`,
- SSA,
- callgraph,
- interface implementation resolution.

### TypeScript / JavaScript / Vue

The v0.1 analyzer extracts common declarations/imports/calls conservatively.

Planned deep analysis:

- TypeScript Compiler API `Program` + `TypeChecker`,
- Vue `@vue/compiler-sfc`,
- path alias resolution,
- component/store/API relationships.

## Storage

SQLite is the query database. JSONL files are transparent exports for inspection, diffing and interoperability.

Generated `.context-index` data is disposable and can always be rebuilt from source plus optional `.context-features` definitions.

## MCP boundary

MCP is an adapter over the local engine, not the engine itself.

The core indexing/query modules remain usable without MCP or any AI system.
