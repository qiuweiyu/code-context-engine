# Code Context Engine

[English](README.md) | [中文](README-ZH.md)

**把本地代码仓库转换成可查询的代码地图——无需大模型、无需云服务、无需上传源码。**

Code Context Engine（CCE）是一个本地优先的静态代码分析工具。它读取 Git 仓库中的源代码，通过 AST、静态分析和确定性规则生成结构化代码知识索引，并通过 CLI 和 MCP 提供查询能力。

CCE 面向开发者、IDE、CI 和 Coding Agent。核心索引流程不依赖任何 AI 模型或外部 API。

**快速开始：** [中文操作流程](docs/QUICKSTART-ZH.md) · [English Quick Start](docs/QUICKSTART.md)

## 为什么做这个项目

大型项目持续开发后，真正昂贵的往往不是修改代码本身，而是反复重新理解项目：

- 某个方法在哪个文件；
- 谁调用了它；
- 它又调用了哪些方法；
- 某个页面对应哪个后端接口；
- 一个功能从前端到数据库经过哪些代码；
- 修改一个方法后哪些功能可能受影响；
- 应该运行哪些测试。

对于 AI Coding Agent 来说，这个问题更加明显。大量 token 会消耗在“重新探索整个仓库”上。

CCE 希望先通过本地静态分析把项目整理成一个机器可查询的代码地图，让人类开发者或 Coding Agent 只读取真正相关的源码。

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

## 核心原则

- **Local-first**：源码保留在本机。
- **No LLM Required**：索引和检索是确定性的代码操作，不依赖 ChatGPT、Claude 或其他大模型。
- **Incremental**：通过文件 hash 跳过未变化文件，只重新分析变化部分。
- **Freshness-aware**：函数实现、签名或描述变化后，相关 Feature 会自动进入 `needs_review`。
- **Stale Detection**：方法被删除或改名后，仍引用旧 Symbol 的 Feature 会自动标记为 `stale`。
- **Source of Truth**：源码始终是事实来源，结构索引可以随时重新生成。
- **Evidence-first**：文件路径、行号、函数签名、参数、调用关系等来自源码分析，而不是 AI 猜测。
- **Agent-ready**：可以通过 CLI / MCP 提供给 Codex、ChatGPT、Claude Code、Cursor、IDE 或 CI。
- **明确表达不确定性**：对于反射、动态分派、运行时注册、配置驱动调用等静态分析无法证明的关系，不假装是确定事实。

## 当前状态

`v0.1.5` 是早期开源基线。

当前已包含：

- Go：基于 AST 的函数/方法、签名、注释、调用和 import 提取；
- TypeScript / JavaScript：函数、import 和调用引用基础提取；
- Vue SFC：提取 `<script>` / `<script setup>` 后进行 TS/JS 分析；
- SQL 与 HTTP Route：轻量确定性识别；
- Tests：根据测试文件名和调用关系建立测试映射；
- SQLite + JSONL 索引；
- 增量更新；
- Feature Freshness；
- CLI 查询；
- MCP 只读接口。

目前 TypeScript/Vue 分析仍然是保守实现。后续会迁移到 TypeScript Compiler API 和 Vue `@vue/compiler-sfc`。

## 会生成什么

执行索引后，会在目标仓库中生成：

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

例如一个方法记录：

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
  "returns": [
    { "name": "", "type": "error" }
  ],
  "file": "internal/task/service.go",
  "lines": [182, 246]
}
```

## Feature Flow 的目标

CCE 不只是记录“有哪些方法”，还希望逐步生成一个功能从开始到结束经过的完整代码路径，例如：

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

第一阶段优先建立准确的 Symbol、Call、Route、Database 和 Test 关系。

后续版本会进一步自动发现功能入口并生成跨层 Feature Flow。

## Feature Freshness

CCE 把源码视为唯一事实来源。

Feature 定义只引用稳定的 `symbol_id`，不会把参数、文件位置、行号复制成另一份“权威事实”。导出 Feature 时，这些信息会从最新 Symbol Index 动态解析。

当代码发生变化：

```text
file hash changes
    ↓
file is re-indexed
    ↓
symbol implementation_hash / semantic_hash changes
    ↓
dependent feature becomes needs_review
```

如果被引用的方法改名或删除：

```text
feature status → stale
```

`stale` Feature 在修复引用之前，不应该继续作为可靠上下文提供给开发者或 Coding Agent。

## 环境要求

- Node.js 22.13+
- Git
- 如果需要分析 Go 项目，还需要 Go

## 从源码安装

```bash
git clone https://github.com/qiuweiyu/code-context-engine.git
cd code-context-engine
npm install
```

## CLI 使用

建立或刷新索引：

```bash
node src/cli.js index --repo /path/to/project
```

根据开发任务查询相关上下文：

```bash
node src/cli.js query \
  --repo /path/to/project \
  --task "编辑未发布的人工任务"
```

查看索引和 Feature 新鲜度：

```bash
node src/cli.js status --repo /path/to/project
```

强制全量重建：

```bash
node src/cli.js index --repo /path/to/project --force
```


## 中文任务与英文代码的别名映射

CCE 不使用大模型翻译开发任务。为了让中文需求能够检索英文方法名、文件名和 Route，查询层提供两种确定性机制：

1. 内置常见开发术语映射，例如 `管理端 → admin`、`小程序 → miniprogram`、`人工任务 → manualtask`；
2. 项目可以在根目录增加 `.context-query-aliases.json`，维护少量业务词别名。

例如：

```json
{
  "定向任务": ["manualtask", "manual_task"],
  "宠物成长": ["petgrowth", "pet_growth"]
}
```

别名只在执行 `query` 时读取，因此修改别名后不需要重新建立索引。

## MCP

CCE 同时提供一个面向本地索引的 MCP Server。

当前工具：

- `context_index_repo`
- `context_query`
- `context_index_status`

MCP Server 本身不依赖模型，只允许访问 `CCE_ALLOWED_ROOTS` 指定目录下的仓库。

例如：

```bash
export CCE_ALLOWED_ROOTS=/home/me/projects
node src/server.js
```

这样 Codex、ChatGPT、Claude Code 或其他支持 MCP 的工具，可以先查询 CCE，再决定真正需要读取哪些代码文件。

## 查询结果

CCE 不会把整个仓库一次性返回给调用方，而是生成紧凑的 Context Manifest：

```json
{
  "features": [],
  "must_read": [
    {
      "path": "internal/task/service.go",
      "symbols": [
        "go:internal/task/service.go::*Service.UpdateManualTask"
      ]
    }
  ],
  "maybe_read": [],
  "tests": [
    "internal/task/service_test.go"
  ],
  "coverage": {
    "status": "sufficient"
  }
}
```

开发者或 Coding Agent 再根据这个结果读取真正的源码。

## 可选的 Feature 定义

项目可以在：

```text
.context-features/*.json
```

中维护少量静态分析无法可靠推断的业务语义，例如：

- 功能名称；
- 功能目的；
- 功能步骤顺序；
- 业务 invariant；
- 对源码 `symbol_id` 的引用。

不要在 Feature 文件里手工维护：

- 方法参数；
- 返回值；
- 文件路径；
- 行号；
- 方法实现描述。

这些信息都应该由源码自动生成。

## 安全模型

CCE 的核心目标之一是避免源码和敏感信息被无意发送到外部系统：

- 核心引擎不进行网络请求；
- `.env`、私钥、证书、常见凭据文件和 lockfile 默认不参与源码索引；
- 读取源码时不跟随 symlink；
- MCP 访问路径由 `CCE_ALLOWED_ROOTS` 限制；
- 不需要 API Key；
- 不需要云服务；
- 不需要 AI 模型。

需要注意：生成的索引本身仍然可能暴露项目结构，因此对于私有仓库，同样应按源码敏感级别保护 `.context-index`。

## 架构

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

详细设计请查看 [ARCHITECTURE.md](ARCHITECTURE.md)。

## Roadmap

详细路线图请查看 [ROADMAP.md](ROADMAP.md)。

近期计划：

1. 接入 TypeScript Compiler API；
2. 接入 Vue `@vue/compiler-sfc`；
3. 自动识别 Entry Point 和 Feature Flow；
4. 为调用关系加入更明确的 evidence / confidence；
5. 支持 SCIP 导出；
6. 建立代码索引正确率与增量性能 Benchmark；
7. 增加语言 Analyzer 插件机制；
8. 后续可选支持语义排序 Provider，但不会成为核心引擎的必需依赖。

## 非目标

CCE 不是：

- 代码生成大模型；
- 编译器测试或运行时测试的替代品；
- 动态运行行为的绝对证明；
- 托管源码的云服务。

## 贡献

欢迎贡献代码。

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

MIT
