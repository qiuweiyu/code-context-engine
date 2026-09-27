# CCE 后续开发计划

状态：**已规划 / 尚未开始开发**

规划日期：2026-09-27

本次文档收口前的代码基线：`4f69f4852bc622ed7ae281a268498fd7f2daaf86`（`v0.1.7`）。

本文档冻结 WP7 之后的后续工程顺序。当前 Ubuntu / Windows 开发机器未启动，因此本阶段只允许进行 GitHub 远端文档治理，不视为已经开始 WP8 代码开发。

## 1. 当前已验收基线

WP7 已完成。

本次文档更新前已经验收的事实：

- 版本：`0.1.7`
- 代码基线：`4f69f4852bc622ed7ae281a268498fd7f2daaf86`
- 合并后测试：38/38 PASS
- GitHub CI：Ubuntu + Windows PASS
- Compact CLI/MCP 输出：已验收
- WP7 Full 输出兼容性：保持
- 真实 SGC 三组 Compact Benchmark：序列化输出约减少 93%，且待读路径、coverage 状态和 tests 保持
- typed graph、有界 traversal、跨 surface retrieval 已经属于当前实现，不再列为未来能力

本次文档收口合并后，`main` 会产生新的提交 SHA。后续恢复开发时以 `origin/main` 为唯一远端基线，不要把文档更新前 SHA 当成新的 HEAD。

## 2. 当前暂停边界

当前 Ubuntu 和 Windows 开发机器均未启动。

因此本阶段只执行：

- GitHub 项目文档更新；
- Roadmap / Architecture 与真实代码能力同步；
- 冻结后续工作包顺序。

在机器启动并明确执行同步之前，不假定任何本地仓库已经包含本次文档更新。

**WP8 代码开发必须等下面的恢复门禁通过后再开始。**

## 3. 机器启动后的恢复门禁

### Ubuntu 开发仓库

历史约定位置：

```text
/opt/CCE/code-context-engine
```

先检查，不破坏任何本地修改：

```bash
cd /opt/CCE/code-context-engine
git status --short --branch
git remote -v
git fetch --prune origin
git rev-list --left-right --count main...origin/main
```

如果 worktree 干净，并且 main 可以安全 fast-forward：

```bash
git checkout main
git pull --ff-only origin main
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
npm install
npm test
```

进入开发前必须满足：

- 本地 `main = origin/main`
- divergence = `0/0`
- worktree clean
- 当前完整测试 PASS

如果发现本地未提交修改，先保留并分析，不默认使用 destructive reset，不允许为了同步直接丢弃未知修改。

### Windows 仓库

历史约定位置：

```text
D:/Tools/code-context-engine
```

PowerShell 检查：

```powershell
Set-Location D:/Tools/code-context-engine
git status --short --branch
git remote -v
git fetch --prune origin
git rev-list --left-right --count main...origin/main
```

如果干净且可以 fast-forward：

```powershell
git checkout main
git pull --ff-only origin main
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
npm install
npm test
```

同样禁止在未确认本地修改来源前直接覆盖或删除。

## 4. 后续正式工作包

### WP8 — Language Analyzer Architecture & Plugin Contract

目标：**先把多语言扩展接口稳定下来，再增加 Java / Python 等新语言。**

范围：

1. 定义稳定的 Language Analyzer 接口。
2. 把以下职责分开：
   - language detection；
   - analyzer 选择/调度；
   - 原生 parser/compiler 执行；
   - 统一 CCE Facts 输出。
3. 定义统一输出：
   - files；
   - symbols；
   - dependencies/imports/calls；
   - 支持时输出 routes/client requests；
   - 支持时输出 data objects；
   - tests；
   - diagnostics。
4. 定义 Analyzer Capability，例如：
   - symbols；
   - imports；
   - calls；
   - types；
   - routes；
   - database evidence；
   - tests；
   - exact resolution。
5. 定义 analyzer/parser version 与增量索引失效规则。
6. 定义 partial result / error 边界。
7. 保持现有 Go / TypeScript / JavaScript / Vue 行为向后兼容。
8. 增加 Analyzer Contract 测试。
9. 明确未来 Java、Python、C/C++、C#、Rust 等语言只通过 Adapter 接入，不让语言判断散落到 graph/retrieval 核心。

本包明确不做：

- 不直接实现 Java Analyzer；
- 不直接实现 Python Analyzer；
- 不增加 LLM / Embedding 必选依赖；
- 不增加 SGC 项目硬编码；
- 除非为保持兼容性所必需，不继续扩张 retrieval heuristic。

验收要求：

- 原有 38 个测试继续 PASS；
- 新增 Contract 测试 PASS；
- 当前真实项目 query 行为保持兼容；
- Graph / Retrieval / MCP 消费统一 Facts，而不是为未来语言不断增加核心层分支；
- 文档同步到实际实现。

### WP9 — TypeScript Compiler API

将 TS/JS 从当前保守文本分析推进到 compiler-backed 的 symbol/import/call 解析。

必须同时做现有 fixture 回归和真实项目 Benchmark 对比。

### WP10 — Vue compiler-sfc

接入 `@vue/compiler-sfc`，可靠处理 `<script>`、`<script setup>`、常见宏以及 component/composable/store/API 关系。

### WP11 — TypeScript / JavaScript 模块解析

增加：

- tsconfig/jsconfig alias；
- re-export / barrel；
- package/module resolution；
- 更稳健的生成代码排除。

### WP12 — Go go/packages + go/types

加入 Go 原生 package/type 证据，提高 interface、generic、跨包方法解析精度；现有 AST Facts 保留为确定性基础/回退证据。

### WP13 — Go SSA / callgraph

在项目 build/package 条件允许时加入 SSA 与 compiler-backed callgraph，提高复杂调用链精度。

### WP14 — Benchmark Corpus & Quality Metrics

在 CCE 仓库建立可复现、带 Ground Truth 的 Benchmark。

指标至少包括：

- call/route/test Precision / Recall；
- Graph Edge 正确率；
- Retrieval Top-K Hit Rate / MRR；
- 全量索引耗时；
- 增量索引耗时；
- Query 耗时；
- Full / Compact 输出大小。

### WP15 — 非 HTTP Feature Flow

在语言解析精度稳定后，再增加：

- entry-point registry；
- CLI command flow；
- scheduled job；
- event consumer；
- queue publish/consume；
- 其他事件型链路。

### WP16 — Interoperability

实现 SCIP、稳定公开 JSON Schema，以及建立在 WP8 Contract 上的公开 Plugin API。

### WP17 — IDE / Graph Visualization

等 Schema / Plugin 边界稳定后再进行编辑器和图谱可视化原型。

### WP18 — Optional Semantic Providers

最后再考虑可选的语义/Embedding/LLM Provider。

底线：

- 不成为核心索引/query 的必需依赖；
- 不替代静态证据；
- 不要求源码上传；
- Local + deterministic 始终是默认模式。

## 5. 多语言支持原则

CCE 的目标不是 Go / TypeScript / Vue 专用工具，而是多语言代码上下文引擎。

最终结构应该是：

```text
各语言原生 Parser / Compiler / Type System
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
        CLI / MCP / Coding Agent
```

WP8 Contract 稳定后，建议语言扩展优先级：

1. Java
2. Python
3. C# / C / C++ / Rust
4. Kotlin / PHP / Ruby / Swift / Dart 等

新增语言时，原则上只增加 Adapter，不应该为每种语言重新修改 Graph / Traversal / Retriever 核心逻辑。

## 6. 分支与工作包治理

每个正式工作包：

1. 从已同步且干净的 `main` 开始；
2. 一个工作包原则上只开一个主要 task branch；
3. 范围只覆盖当前 WP；
4. 跑对应 Regression / Benchmark；
5. 创建 GitHub PR；
6. 验收后合并；
7. 开发机器重新同步 `main`；
8. 安全时删除已结束 task branch；
9. 将最终证据写入工作包记录。

避免继续累计大量长期历史开发分支。

## 7. 下一步

机器启动后只做以下顺序：

1. 安全同步 Ubuntu / Windows 已知仓库；
2. 确认已经取得本次文档收口后的最新 `main`；
3. 执行当前基线测试；
4. **只进入 WP8**。

WP8 未验收前，不直接跳到 Java / Python Analyzer 开发。
