# CCE Development Plan

Status: **planned / not started**

Planning date: 2026-09-27

Code baseline before this documentation convergence: `4f69f4852bc622ed7ae281a268498fd7f2daaf86` (`v0.1.7`).

This document defines the next engineering sequence after WP7. It does not authorize background/local-machine work while the development machines are offline.

## 1. Current accepted baseline

WP7 is complete.

Accepted facts before this documentation-only update:

- version: `0.1.7`
- main code baseline: `4f69f4852bc622ed7ae281a268498fd7f2daaf86`
- post-merge tests: 38/38 PASS
- GitHub CI: Ubuntu + Windows PASS
- Compact CLI/MCP projection: accepted
- Full output compatibility: preserved in WP7 acceptance
- three real SGC Compact benchmarks: approximately 93% serialized-output reduction while preserving selected paths, coverage status and tests
- typed graph, bounded traversal and cross-surface retrieval are already implemented

The documentation convergence itself will create a newer `main` commit. When development resumes, `origin/main` is authoritative; do not assume the pre-documentation SHA is still HEAD.

## 2. Development pause boundary

At the time this plan is written, the Ubuntu and Windows development machines are not running.

Therefore this phase is intentionally limited to:

- GitHub documentation updates,
- roadmap/architecture synchronization,
- future work-package definition.

Do **not** treat any local Ubuntu/Windows repository as synchronized until it has been explicitly checked after the machine starts.

No WP8 code implementation begins before the resume gate below passes.

## 3. Resume gate when machines are available

### Ubuntu development clone

Expected historical location:

```text
/opt/CCE/code-context-engine
```

First inspect; do not destroy local work:

```bash
cd /opt/CCE/code-context-engine
git status --short --branch
git remote -v
git fetch --prune origin
git rev-list --left-right --count main...origin/main
```

If the worktree is clean and `main` can fast-forward safely:

```bash
git checkout main
git pull --ff-only origin main
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
npm install
npm test
```

Required gate:

- local `main` = `origin/main`
- divergence = 0/0
- worktree clean
- existing full test suite PASS

If local changes exist, preserve and inspect them before any pull/reset. Do not use destructive reset as the default synchronization method.

### Windows clone

Expected historical location:

```text
D:/Tools/code-context-engine
```

PowerShell inspection:

```powershell
Set-Location D:/Tools/code-context-engine
git status --short --branch
git remote -v
git fetch --prune origin
git rev-list --left-right --count main...origin/main
```

If clean and fast-forward safe:

```powershell
git checkout main
git pull --ff-only origin main
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
npm install
npm test
```

The same preservation rule applies: do not discard unknown local modifications.

## 4. Engineering sequence

### WP8 — Language Analyzer Architecture & Plugin Contract

Goal: make language support extensible before adding more language implementations.

Scope:

1. Define a stable analyzer interface.
2. Separate:
   - language detection,
   - analyzer selection/dispatch,
   - native parser/compiler execution,
   - normalized CCE fact production.
3. Define normalized analyzer output:
   - files,
   - symbols,
   - dependencies/imports/calls,
   - routes/client requests where supported,
   - data objects where supported,
   - tests,
   - diagnostics.
4. Define analyzer capability metadata, for example:
   - symbols,
   - imports,
   - calls,
   - types,
   - routes,
   - database evidence,
   - tests,
   - exact resolution.
5. Define analyzer/parser version rules and incremental-index invalidation behavior.
6. Define partial-result/error behavior.
7. Keep current Go / TypeScript / JavaScript / Vue behavior backward compatible.
8. Add analyzer contract tests.
9. Document how future Java, Python, C/C++, C#, Rust and other adapters integrate without changing graph/retrieval core behavior.

Non-goals:

- no Java analyzer yet,
- no Python analyzer yet,
- no new LLM/embedding dependency,
- no SGC-specific hardcoding,
- no retrieval heuristic expansion unless required to preserve existing behavior.

Acceptance:

- current 38-test baseline remains PASS,
- new contract tests PASS,
- current real-project query behavior remains compatible,
- graph/retrieval/MCP modules consume normalized facts without language-specific branching added for future languages,
- documentation updated with the implemented contract.

### WP9 — TypeScript Compiler API

Move TS/JS analysis toward compiler-backed symbol/import/call evidence.

Acceptance must include compatibility tests against current fixtures and real-project benchmarks.

### WP10 — Vue compiler-sfc

Use `@vue/compiler-sfc` for SFC parsing and improve script-setup/macros/component relationships.

### WP11 — TypeScript/JavaScript module resolution

Add tsconfig/jsconfig aliases, re-exports/barrels and stronger module resolution.

### WP12 — Go go/packages + go/types

Add compiler/type-system evidence while retaining deterministic AST facts as fallback/source evidence.

### WP13 — Go SSA / callgraph

Add higher-confidence callgraph evidence for cases where build/package configuration permits it.

### WP14 — Benchmark Corpus & Quality Metrics

Create checked-in benchmark repositories/fixtures with ground truth.

Measure:

- call/route/test precision and recall,
- graph edge correctness,
- retrieval Top-K hit rate / MRR,
- index time,
- incremental index time,
- query time,
- Full/Compact serialized size.

### WP15 — Non-HTTP feature flows

Add entry-point/event/job/queue/CLI flow modeling after language-resolution quality is stable.

### WP16 — Interoperability

SCIP export, stable public schema and public plugin surface based on the WP8 contract.

### WP17 — IDE / graph visualization

Build editor/visualization prototypes only after schema/plugin boundaries are stable.

### WP18 — Optional semantic providers

Optional semantic/embedding/LLM ranking may be explored as plugins.

Core rules:

- never required for indexing/querying,
- never replace deterministic evidence,
- never require source upload,
- local deterministic mode remains the default.

## 5. Language expansion policy

CCE is a multi-language engine, not a Go/TypeScript/Vue-only product.

The intended model is:

```text
Native parser/compiler/type system
            ↓
Language Analyzer Adapter
            ↓
Normalized CCE Facts
            ↓
Typed Graph
            ↓
Traversal / Retrieval
            ↓
Full / Compact
            ↓
CLI / MCP / Agents
```

Candidate future adapters, after WP8 stabilizes the contract:

1. Java
2. Python
3. C# / C / C++ / Rust
4. Kotlin / PHP / Ruby / Swift / Dart and others

The core graph/retrieval layer should not need per-language conditionals for each new adapter.

## 6. Branch and work-package policy

For each substantial work package:

1. start from synchronized, clean `main`,
2. create one bounded task branch,
3. keep scope limited to the current WP,
4. run the relevant regression/benchmark gates,
5. open a GitHub PR,
6. merge only after acceptance,
7. sync the development clone back to `main`,
8. delete completed task branches when safe,
9. record final evidence in the work-package documentation/tracker.

Avoid accumulating unnecessary long-lived branches.

## 7. Next action

When a development machine is available:

1. synchronize both known clones safely,
2. confirm the documentation-converged `main`,
3. run the existing baseline tests,
4. begin **WP8 only**.

Do not skip directly to Java/Python implementation before WP8 is accepted.
