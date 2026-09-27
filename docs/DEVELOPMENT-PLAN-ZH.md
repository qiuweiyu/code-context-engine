# CCE 后续开发计划

状态：**WP8-A 已合并；WP8-B 开发中；WP9 及之后尚在规划阶段**。

规划前代码基线：`4f69f4852bc622ed7ae281a268498fd7f2daaf86`（v0.1.7）；文档基线：`8ef900b7f51182cbe5af63cfb3fb13686e6a9299`。

2026-09-27 实测 Ubuntu `/opt/CCE/code-context-engine` 的 main、origin/main 与 GitHub main 均为 `8ef900b7...`，分叉 0/0，原有 38/38 测试通过。保留原有未跟踪 `package-lock.json`。本轮没有核验 Windows 同步。WP8-A 已合并为 `f138b03caec29c323cb9f59fdb2b6670be009d42`，WP8-B 从该已合并基线建立分支。

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

文档收口产生 `8ef900b7...`；创建 WP8-A 分支前，Ubuntu main 已实测同步至该提交。

## 2. 当前开发状态

Ubuntu main 的同步及原有测试门禁于 2026-09-27 通过。目前在 `work/cce-wp8b-analyzer-contract` 上推进。原有未跟踪 lockfile 没有加入、覆盖或删除。在 WP8-B PR 验收前，GitHub main 以 WP8-A 合并提交为基线。

## 3. 环境与后续同步门禁

每个新包开始前：核对 GitHub main、本机 main 和 origin/main，先看 `git status --short --branch`，执行 `git fetch --prune origin`，再看 `git rev-list --left-right --count main...origin/main`。确认远端可靠且 main 可快进后才同步；保留无关本地文件。

Ubuntu：`/opt/CCE/code-context-engine`，Node 22.22.1、Go 1.26.0。CI 用 Node 22 / Go 1.25.x，若有差异需记录。Windows 历史仓库：`D:/Tools/code-context-engine`，**本轮未检查**。每次 WP 合并后分别安全同步、运行 `npm test` 和 `npm run benchmark`，记录 SHA/结果。不要 reset/clean 未知修改。

## 4. 调整后的工程顺序（2026-09-27）

本节替代旧的“到 WP14 才建立首个准确率语料”的顺序。WP8-A 到 WP11 已合并。条件式 WP12 SSA/callgraph 门槛暂缓，因为 WP11 冻结语料目前没有需要 SSA 才能解决的已标注漏检。WP13 当前在 `work/cce-wp13-quality-ci` 开发，其余后续工作包尚未开始。分析器升级要和固定标注语料对比，不能只看回归测试全绿。

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
| WP17 | 可选语义 Provider。 | 核心不依赖 LLM/Embedding/源码上传。 | 离线核心可独立运行，附加收益可量化。 |

评估的用法与标注边界见 [BENCHMARKS.md](BENCHMARKS.md)，已实现的内部契约见 [ANALYZER-CONTRACT-ZH.md](ANALYZER-CONTRACT-ZH.md)。当前六组小型语料只是**起步基线**，不能宣称多语言准确率已经达到产品标准。原 WP11 模块解析并入 WP9；原 WP14 Benchmark 提前到 WP8-A。每个工作包仍只用一个有边界的任务分支，PR 记录量测证据。
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

先完成 WP8-B 契约测试、Benchmark 对照和 PR 审阅；验收合并后再从新 main 进入 WP9。提升严格质量门禁前继续扩充 WP8-A 语料。
