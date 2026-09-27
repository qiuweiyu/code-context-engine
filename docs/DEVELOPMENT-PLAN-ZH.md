# CCE 后续开发计划

状态：**WP8-A 到 WP17 已合并；WP18 第一版公开 Release Readiness 正在进行。**

WP18 开始前已验收 main 基线：`f68924463c2408de5e61fb362f838a19397df8ed`；WP18 Release 目标：`v0.2.0`。

历史未跟踪 `package-lock.json` 继续受保护，不得加入、删除或重写。已验收 SHA-256：`771655d3d1dfa7abfd04a8a86c4b4fe533b6a5521a7951bb976a53678beda710`。

## 1. 当前已验收基线

WP17 已完成。进入 WP18 时的已验收事实：

- WP18 前 package version：`0.1.7`；WP18 目标：`0.2.0`
- main/origin/main：`f68924463c2408de5e61fb362f838a19397df8ed`
- Regression：85/85 PASS
- Ground Truth v6：TP=34、FP=1、FN=0
- Semantic Corpus v1：PASS；OFF/ON MRR 0.1567 → 0.4567
- Public Index v1、SCIP、Plugin Protocol v1、Locate、Offline Graph 已合并
- Optional Semantic Provider v1 已合并，且只能显式启用
- Ubuntu + Windows CI 均属于 Release Gate

## 2. 当前开发状态

WP18 从已验收 WP17 main 建立 `work/cce-wp18-release-readiness`。范围仅包括打包、公开文档、Clean Install Smoke、Release CI、Tag 与 GitHub Release；不新增 Analyzer 或 Retrieval Algorithm。

## 3. 环境与后续同步门禁

每个新包开始前：核对 GitHub main、本机 main 和 origin/main，先看 `git status --short --branch`，执行 `git fetch --prune origin`，再看 `git rev-list --left-right --count main...origin/main`。确认远端可靠且 main 可快进后才同步；保留无关本地文件。

Ubuntu：`/opt/CCE/code-context-engine`，Node 22.22.1、Go 1.26.0。CI 用 Node 22 / Go 1.25.x，若有差异需记录。Windows 历史仓库：`D:/Tools/code-context-engine`，**本轮未检查**。每次 WP 合并后分别安全同步、运行 `npm test` 和 `npm run benchmark`，记录 SHA/结果。不要 reset/clean 未知修改。

## 4. 调整后的工程顺序（2026-09-27）

本节替代旧的“到 WP14 才建立首个准确率语料”的顺序。WP8-A 到 WP17 已合并。条件式 WP12 SSA/callgraph 门槛继续暂缓，因为当前冻结语料没有需要 SSA 才能解决的已标注漏检。当前进入 WP18 Release Readiness；除非发现明确 Release Blocker，否则不再改 Analyzer。

| 工作包 | 目标与范围 | 非目标与依赖 | 验收与风险 |
| --- | --- | --- | --- |
| WP8-A | 建立正反图边标注、相关文件标注、可重复的评估脚本，以及索引/查询耗时和输出大小指标；起步语料已加入 Go 多实现、TS barrel、Vue 双脚本、Route 歧义及注释误检；后续继续扩充 JS alias、动态导入和真实仓库标注。 | 不改 parser/Retriever；依赖 v0.1.7。 | 仅在**已标注事实集合**计算 Precision/Recall，并记录 Top-K/MRR、冷/热索引、查询时间与字节数；风险是样本太少导致误判。 |
| WP8-B | 内部语言分析契约：调度、Fact 来源、诊断、部分结果、各分析器版本失效规则；先封装现有分析器。 | 暂不承诺公共插件 ABI，不加新语言；依赖 WP8-A。 | 原 39 项回归及固定查询兼容，失败不得悄悄当作空结果；风险是符号 ID/Schema 迁移。 |
| WP9 | **合并** TS/JS Compiler API 与模块解析：Program/TypeChecker、tsconfig/jsconfig alias、barrel/re-export。 | 不顺手调整 Retriever；依赖 WP8-B。 | 标注 import/call 与检索结果改善，不能引入未经评审的误连；记录索引成本。风险是配置缺失和内存。 |
| WP10 | Vue compiler-sfc、双 script、script setup 宏以及页面/组件/composable 关系。 | 不追求一次覆盖 Vue 全生态；依赖 WP9。 | SFC 标注与真实项目链路对照；风险是源码位置映射和 template 语义。 |
| WP11 | Go go/packages、go/types，跨包调用、方法集、泛型与接口证据。 | 暂不做 SSA；依赖 WP8-B。 | 对比正确/错误/unresolved 边及运行成本；风险是构建标签与依赖缺失。 |
| WP12 | 若 WP11 的量测证明值得，做 Go SSA/callgraph 试点。 | 可能调用不冒充唯一运行目标；依赖 WP11。 | DI/多实现的精度和成本门槛；风险是图膨胀。 |
| WP13 | 扩大到多项目语料，并加入质量、性能 CI 门禁。 | 首批基线已在 WP8-A；依赖 WP9–12。 | 多系统可复现，回归阈值有记录。 |
| WP14 | CLI/job/consumer/queue 等非 HTTP 入口与流程。 | 保留已实现 HTTP 流程，依赖可靠 Facts。 | 入口至数据/测试的标注链路。 |
| WP15 | SCIP、稳定公共 Schema 和第三方插件 API。 | 不过早冻结 ABI；依赖多个真实分析器。 | 有版本化消费者及迁移案例。 |
| WP16 | IDE/图可视化原型。 | 依赖 WP15。 | 可定位源代码及依据。 |
| WP17 | 可选语义 Provider：版本化本地进程协议、有界 rerank、显式 opt-in。 | 核心不依赖 LLM/Embedding/厂商 SDK/源码上传，Provider 不拥有图事实。 | Provider 关闭时基线兼容；量化 OFF/ON 检索收益、延迟和 fallback。 |
| WP18 | 第一版公开 Release Readiness：npm 包面、公开文档、Clean Install Smoke、Release CI、Tag 与 GitHub Release。 | 不扩 Analyzer/Retriever 功能。 | v0.2.0 tarball 可重复安装，Ubuntu/Windows PASS，完成 Post-merge 与 Release Artifact。 |

评估的用法与标注边界见 [BENCHMARKS.md](BENCHMARKS.md)，已实现的内部契约见 [ANALYZER-CONTRACT-ZH.md](ANALYZER-CONTRACT-ZH.md)。当前冻结的小型语料仍只是**起步基线**，不能宣称多语言准确率已经达到产品标准。原 WP11 模块解析并入 WP9；原 WP14 Benchmark 提前到 WP8-A。每个工作包仍只用一个有边界的任务分支，PR 记录量测证据。
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

完成 WP18 打包、文档与 Release Gate；合并到已验收 main 后验证 v0.2.0 tarball，创建 v0.2.0 Tag 与 GitHub Release，再从该 Release Baseline 开始下一功能包。
