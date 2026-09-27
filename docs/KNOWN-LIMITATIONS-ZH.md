# v0.2.0 已知限制

CCE v0.2.0 是静态分析与代码检索工具，设计上会偏保守，而不是猜测运行时行为。

## 当前支持的分析器

v0.2.0 主要支持：

- Go
- TypeScript
- JavaScript
- Vue SFC
- 围绕这些技术栈的轻量 HTTP / SQL / Test / Entry Point 提取

尚未作为正式一等分析器支持：

- Java
- Python
- C / C++
- C#
- Rust
- Kotlin、PHP、Ruby、Swift、Dart 等其他生态

这些语言的文件可以存在于仓库中，但 v0.2.0 不承诺与 Go/TS/JS/Vue 相同等级的 Symbol / Call 分析。

## 静态分析边界

CCE 不声称可以还原全部运行时行为。

反射、运行时依赖注入、动态分派、生成代码、配置驱动 wiring、eval 类行为和高度动态 import 可能保持 unresolved。

unresolved edge 不会被当成已证明事实继续遍历。

TS/JS 框架注册、Queue/Event Flow 只识别当前已经实现的有限静态模式。

Go 项目在本机 Go toolchain 能正确加载 package 时会得到更强的类型证据；类型加载不完整时仍保留 AST 事实。

## 检索边界

确定性 Retriever 依赖已经建立的索引事实、命名、Alias 和 Graph Evidence。
Query 没有命中，不代表功能一定不存在。

Semantic Provider v1 不能引入确定性 Retriever 候选集合之外的新文件。
它只改进排序，不创造事实。

## 平台与规模

当前 CI 正式验证 Ubuntu 和 Windows。

macOS CI 还不是 v0.2.0 Release Gate 的一部分。

仓库内的 Ground Truth 是刻意保持较小的标注语料；Precision / Recall 只描述该语料，不代表所有真实项目。

大型 Monorepo 的专项增量性能 Benchmark 仍属于后续工作。

Node.js 22 可能对内置 `node:sqlite` 输出 ExperimentalWarning。该 warning 本身不代表 CCE 执行失败。

## 公共兼容边界

Public Index v1、SCIP Export 与版本化 Public Protocol 是推荐的外部集成边界。

内部 SQLite 表结构与内部 JSONL 布局属于实现细节，后续可能演进。

公共兼容规则见 [INTEROPERABILITY-ZH.md](INTEROPERABILITY-ZH.md)。
