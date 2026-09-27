# Semantic Provider Protocol v1

状态：WP17 Stage 1 架构冻结。

本文定义 Code Context Engine（CCE）第一版可选语义 Provider 边界。设计目标是：接口小、优先本地、厂商无关，并且始终从属于确定性核心。

## 1. 不可破坏的原则

确定性 Analyzer、Typed Graph 和 Retriever 始终是事实来源。

Semantic Provider：

- 必须由调用方显式启用；
- 不能因为 `semantic_refinement_recommended=true` 就自动运行；
- 不能新增、删除或修改图事实；
- 不能修改 edge confidence；
- 不能引入确定性候选集合之外的新文件；
- CCE 不能向 Provider 发送仓库源码正文；
- 正常 index、query、flow、Public Index、SCIP、locate、graph-html 不能依赖 Provider；
- CCE 核心和 CI 不能强制依赖任何厂商 SDK、模型 API Key、Embedding Runtime 或网络；
- Provider 只能给确定性 Retriever 已经产生的有限候选提供语义分数。

Provider 执行失败、超时或返回非法结果时，CCE 必须退回确定性结果，不能让 query 因此失败。

## 2. 传输方式

Protocol v1 使用本地外部进程。

CCE 启动用户显式配置的可执行程序，向 stdin 写入且只写入一个 UTF-8 JSON 请求，关闭 stdin，然后从 stdout 读取且只读取一个 UTF-8 JSON 响应。

Provider 的 stderr 只作为诊断信息，不参与协议解析。

以下任一情况都触发确定性 fallback：

- 非 0 退出码；
- 超时；
- 非法 JSON；
- 不支持的协议版本；
- schema 校验失败。

该边界与实现语言无关，Provider 可以使用 Node.js、Python、Go、Java 等语言实现。协议不禁止用户自己配置的 Provider 联网；约束是 CCE 核心不要求网络，也不会静默启用网络能力。

## 3. Provider 配置

第一版优先采用显式的本地 Provider Spec JSON 文件，而不是在核心 CLI 中加入厂商专用参数。

示例：

```json
{
  "protocol": "cce.semantic-provider-spec",
  "version": "1.0",
  "command": "python3",
  "args": ["./tools/semantic-provider.py"],
  "timeout_ms": 1500,
  "weight": 0.25
}
```

规则：

- `command` 必填且不能为空；
- `args` 默认空数组；
- `timeout_ms` 必须有边界；WP17 目标范围 100～10000 ms，默认 1500 ms；
- `weight` 必须在 0～0.35 之间，默认 0.25；
- 协议不使用 shell 字符串拼接；CCE 应直接按 command + args 数组启动进程。

## 4. Request Schema

协议标识：

```text
cce.semantic-provider
```

主版本：

```text
1
```

请求示例：

```json
{
  "protocol": "cce.semantic-provider",
  "version": "1.0",
  "request_id": "opaque-per-query-id",
  "task": "查找老师发布作业的位置",
  "candidates": [
    {
      "path": "src/example.js",
      "deterministic_rank": 1,
      "deterministic_score": 42.5,
      "reasons": ["symbol_match", "route:POST /homework"],
      "symbol_hints": ["HomeworkService.publish"]
    }
  ]
}
```

规范：

- `request_id` 是本次调用唯一的不透明 ID；
- `task` 是调用方查询文本；
- `candidates` 只能来自确定性 Retriever；
- path 必须是 Retriever 已知的仓库相对路径；
- `deterministic_rank` 从 1 开始，代表 Provider 介入前的原始顺序；
- `deterministic_score` 只用于调试，Provider 不能假设它跨版本具有固定数值尺度；
- `reasons` 与 `symbol_hints` 是有限 metadata，不是源码正文；
- CCE 不得包含文件正文、任意文件系统内容、SQLite 数据库、环境变量秘密或凭据；
- 请求候选必须有限；WP17 目标最多 64 个；
- 初始候选池目标：`min(rankedFiles.length, max(24, maxFiles * 3), 64)`。

## 5. Response Schema

响应示例：

```json
{
  "protocol": "cce.semantic-provider",
  "version": "1.0",
  "request_id": "opaque-per-query-id",
  "provider": {
    "id": "example.semantic",
    "version": "0.1.0"
  },
  "scores": [
    {
      "path": "src/example.js",
      "semantic_score": 0.93,
      "reason": "语义与发布作业处理逻辑匹配"
    }
  ],
  "diagnostics": []
}
```

规范：

- `protocol`、主版本和 `request_id` 必须与请求一致；
- `provider.id` / `provider.version` 必须是非空字符串；
- 每一个请求候选必须在 `scores` 中且只能出现一次；
- 不允许出现候选集合之外的 path；
- 不允许重复 path；
- `semantic_score` 必须是 [0, 1] 范围内的有限数值；
- `reason` 可选，只能是有限诊断文本；
- `diagnostics` 可选，只能是有限诊断 metadata；
- 任一违规都会使整个 response 无效，v1 不对非法响应进行部分应用。

## 6. 确定性 / 语义融合规则

WP17 使用有边界的 rank-based fusion。这样 Provider 不会变成事实来源，也不依赖历史 deterministic score 的内部数值尺度。

候选池大小为 `N`：

```text
deterministic_component =
    N <= 1
      ? 1
      : 1 - ((deterministic_rank - 1) / (N - 1))

semantic_component = semantic_score

fused_score =
    (1 - weight) * deterministic_component
    + weight * semantic_component
```

约束：

- 默认 `weight = 0.25`
- 最大 `weight = 0.35`
- 最小 `weight = 0`

最终排序：

1. `fused_score` 降序；
2. 原始 `deterministic_rank` 升序；
3. `path` 升序。

原始 deterministic raw score、reasons 与 rank 必须保留在 debug 输出中，不允许覆盖。

采用 rank normalization 的原因：

- 当前确定性检索的不同 score channel 数值量级不同；
- Provider 不应依赖内部 score scale 的偶然变化；
- semantic contribution 有明确上限，容易审计；
- 对确定性 Provider 使用稳定 tie-break 时，重复运行可复现。

## 7. Query 接入位置

Provider 接入顺序必须是：

```text
deterministic candidate generation
        ↓
deterministic ranking
        ↓
bounded semantic candidate prefix
        ↓
optional provider
        ↓
validated bounded fusion
        ↓
existing final selection / maxFiles
```

Provider 不能在确定性候选生成前执行，也不能绕过已有候选集合。

没有显式请求 Provider 时，CCE 必须保持现有确定性路径。WP17 验收需要锁定与 WP16 query baseline 的兼容性。

## 8. 失败处理

Provider 状态分为：

- `disabled`：调用方没有请求；
- `applied`：Provider 返回合法结果并完成融合；
- `fallback`：调用了 Provider，但由于超时、进程异常或校验失败未应用。

当状态是 `fallback`：

- 只要确定性检索本身成功，query 仍然 `ok: true`；
- 排序和 selection 完全使用原始确定性结果；
- full/debug 输出记录有限 Provider 诊断；
- compact 输出仅在调用方显式请求 Provider 时暴露简短 Provider 状态。

Protocol v1 不做自动重试。

## 9. 隐私边界

CCE 生成的 Provider request 可以包含：

- task 文本；
- 仓库相对候选路径；
- deterministic rank/score；
- deterministic retrieval reasons；
- 索引中已有的有限 symbol name hints。

CCE 生成的 Provider request 不得包含：

- 完整源码或源码片段；
- 任意文件读取结果；
- SQLite 内容；
- 环境变量；
- Token、密码、credential 文件。

WP17 测试必须直接检查序列化后的 request，并锁定该隐私边界。

## 10. 量化验收

Provider 是可选检索增强，因此必须比较 OFF 与 ON。

WP17 至少记录：

- Top-K；
- MRR；
- 预先声明的 semantic/paraphrase cases 中相关文件命中情况；
- query latency；
- output bytes；
- fallback 行为；
- graph facts 的 TP/FP/FN 保持不变，因为 Provider 不拥有事实层。

Provider 关闭时，benchmark 和 regression 必须与 WP16 基线兼容。

## 11. 机器可读 Schema

Protocol v1 同时冻结以下严格 JSON Schema：

- `docs/schema/semantic-provider-spec-v1.schema.json`
- `docs/schema/semantic-provider-request-v1.schema.json`
- `docs/schema/semantic-provider-response-v1.schema.json`

JSON Schema 不方便表达的跨记录约束——例如 request candidates 与 response scores 的 path 必须完全一致、禁止重复 path、request_id 必须匹配——仍属于实现层必须执行的校验。

## 12. Protocol v1 不包含

- 自动 Provider discovery；
- 自动网络调用；
- CCE 核心内的 OpenAI / Anthropic / Gemini / Ollama 厂商专用接口；
- Embedding 数据库管理；
- Provider 生成图事实；
- Provider 生成 edge 或提升 confidence；
- 源码上传；
- Agent Loop；
- Java / Python / C / C++ Analyzer Adapter。
