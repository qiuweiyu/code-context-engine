# Code Context Engine

**Turn a local codebase into a queryable code map — no LLM, no cloud, no source upload.**

Code Context Engine (CCE) is a local-first static analysis tool that builds a structured knowledge index for a repository. It extracts files, functions and methods, signatures, comments, call/import edges, routes, database objects, tests, and feature references, then exposes that information through a CLI and MCP server.

CCE is designed for both humans and coding agents. The core indexing path is deterministic and does not require an AI model or external API.


## 中文介绍

Code Context Engine（CCE）是一个**完全本地运行、无需大模型、无需上传源码**的代码知识结构生成工具。

它会直接读取 Git 仓库中的源代码，通过 AST、静态分析和确定性规则自动提取项目结构，并生成可查询的代码知识索引，包括：

- 文件、函数、方法、类和接口；
- 方法参数、返回值、注释、文件位置和代码行范围；
- 函数调用关系、import / dependency 关系；
- HTTP Route 与前后端 API 关联；
- 数据库表及常见 SQL 操作；
- 测试文件与被测代码的关联；
- 功能 Feature 与代码 Symbol 的引用关系；
- 代码变化后的增量索引和 Feature 失效检测。

CCE 的目标不是生成代码，而是先回答开发过程中最常见的一类问题：

> **这个功能在哪里？从哪里开始？经过哪些方法和文件？依赖什么？应该测试什么？**

例如一个功能最终可以被整理成类似这样的调用链：

```text
Vue Page
   ↓
Frontend Function
   ↓
API Client
   ↓
HTTP Route
   ↓
Backend Handler
   ↓
Service
   ↓
Repository
   ↓
Database Table
   ↓
Related Tests
```

这些结构信息由源码自动生成，不需要 AI 根据代码“猜”。

### 为什么做这个项目

大型项目在持续开发后，真正昂贵的往往不是修改代码本身，而是反复重新理解项目：

- 某个方法到底在哪个文件；
- 谁调用了它；
- 它又调用了哪些方法；
- 某个页面对应哪个后端接口；
- 一个功能从前端到数据库经过哪些代码；
- 修改一个方法后哪些功能和测试可能受到影响。

对于 AI Coding Agent 来说，这个问题更加明显。很多 token 都消耗在“重新探索代码仓库”上。

CCE 希望先用本地静态分析把仓库整理成一个**机器可查询的代码地图**，然后人类开发者、IDE、CI 或 AI Agent 只读取真正相关的源码。

```text
Repository
    ↓
Code Context Engine
    ↓
Symbol / Call / Route / Data / Test / Feature Index
    ↓
Compact Context Manifest
    ↓
Human / IDE / Coding Agent
```

### 核心原则

- **100% Local**：核心索引过程不需要把源码发送到任何外部服务。
- **No LLM Required**：生成代码结构不依赖 ChatGPT、Claude 或其他大模型。
- **Source of Truth**：源码始终是真实来源，结构文件由代码重新生成。
- **Incremental**：未变化文件通过 hash 直接跳过，只重新分析变化部分。
- **Freshness-aware**：函数签名、实现或描述变化时，相关 Feature 会自动进入 `needs_review`。
- **Stale Detection**：方法被删除或改名后，仍引用旧 Symbol 的 Feature 会自动标记为 `stale`。
- **Agent-ready**：索引可以通过 CLI / MCP 提供给 Codex、ChatGPT、Claude Code、Cursor 等工具。
- **可解释**：优先保存方法、文件、行号、参数、调用关系等确定性证据，而不是不可验证的 AI 摘要。

### 当前阶段

目前项目处于早期开发阶段（`v0.1.0`）。

第一阶段重点是把以下能力做准：

```text
Source Code
   ↓
Symbol Index
   ↓
Call / Import Graph
   ↓
Route / Database / Test Mapping
   ↓
Feature Freshness
   ↓
SQLite + JSONL
```

后续会继续加强 Go、TypeScript 和 Vue 的语言原生分析能力，并逐步实现：

- 自动识别功能入口；
- 自动生成跨前端、后端、数据库的 Feature Flow；
- 更精确的 Call Graph；
- SCIP 导出；
- IDE / Agent 集成；
- 大型 Monorepo 增量索引性能优化。

> CCE 的长期目标是让一个陌生开发者或 Coding Agent 在进入项目时，不需要先扫描整个仓库，就能快速理解“这个项目有哪些功能，以及每个功能到底由哪些代码组成”。

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
