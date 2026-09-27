# 内部语言分析器契约（WP8-B）

版本 1，代码位于 `src/context/analyzers.js`。这是 CCE 内部接口，**不是**对外承诺兼容的插件 API。Go 继续使用 Go AST；WP9 将已跟踪 TypeScript/JavaScript 切换到 TypeScript Compiler API；WP10 使用精确固定的 `@vue/compiler-sfc@3.5.43` 负责 Vue SFC 结构解析，同时保留保守的脚本级 Fact 提取。`text-facts` 负责没有专用分析器的已跟踪文件。WP9 精确固定 `typescript@6.0.3`，因为当前 TypeScript 7 系列未提供本分析器依赖的稳定 Program/TypeChecker API。

## 调度与产出

`analyzerFor(language)` 根据语言选分析器。描述包括 ID、支持语言、版本、证据类型、能力声明和批量 `analyze` 函数。批量结果以仓库相对路径为键。完成文件的规范化结果包含文件路径/语言/hash、版本、symbols、imports/calls dependencies、routes、DB 对象、可选 tests、包名和诊断。每条 Fact 在内存里带分析器 ID/版本以及 AST 或文本规则证据。当前的 route/client request/DB 提取仍是跨语言的启发式后处理；测试映射仍在图后处理阶段，不冒充语言原生分析能力。

schema 8 的原有列、符号 ID、图边、遍历和检索排序没有换版。Fact 的新增 provenance **尚未作为公共事实结构持久化**，这件事留给以后的稳定 Schema 工作包。AST 事实不自动等于 `exact`。Vue 适配器只把 compiler-sfc 用于可信的 SFC block 结构和原始位置：normal script 与 script setup 都按原源码偏移分析；Vue 编译器宏不会冒充项目调用；不把 `compileScript` 生成代码当源码证据。

## 失败处理

源码无法读取、分析器异常、Go 语法错误、缺少输出、无效 Fact 或明确声明的 partial 结果，都会生成带文件路径的诊断。失败文件不会被写成“解析成功但零符号”；已有索引事实暂时保留，下一轮无论 hash 是否变化都重试。其他成功文件可正常入库。新文件若分析失败，则待修复后再索引。

`index` 返回 `analysis_failed_files` 和诊断；最新诊断保存在 SQLite meta，可由 `status` 和 Full query 看到。有失败文件且查到候选时，查询覆盖状态会变成 `review_required`；Compact 返回失败文件数。修复成功后清除诊断。保留旧事实不等于旧事实仍代表当前坏文件，开发者应先查看诊断。

## 版本与下一步

`files.parser_version` 使用 `<全局解析版本>/contract1/<分析器ID>@<分析器版本>`；分析器版本变化仍只使对应分析器文件失效。WP9 进一步把 TS/JS 模块解析视为跨文件状态：脚本内容变化会沿已记录的 import 反向链传递失效；新增脚本，或 `tsconfig`/`jsconfig` 修改、删除时，会使本轮已跟踪的 compiler-script 集合重新分析。WP10 在已跟踪 TS/JS/Vue 文件新增或删除时重新分析 Vue 文件，因为模块目标可能在 Vue 源码不变时从 unresolved 变为 resolved（或反向）；普通目标内容变化则复用 import，并由全局依赖解析刷新唯一目标 symbol。hash、解析器版本和仓库结构都不变时，warm index 仍应为 0 changed。通用路由/DB 规则变化仍需升级全局或契约版本。

新语言适配器要给出真实能力、确定性版本、路径归属与 unresolved 依据，并为成功和失败路径添加 Ground Truth。Java/Python/C++ 编译器集成以及对外插件 ABI 属于后续工作包。验收运行 `npm test`、`npm run benchmark`；WP8-A 的已知漏检和误连仍是对照基线，默认 Benchmark 报告指标，不以这些已知问题阻断 WP8-B。
