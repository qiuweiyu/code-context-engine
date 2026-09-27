# CCE 互操作协议 v1

WP15 新增三类对外互操作能力，但**不冻结** CCE 内部 SQLite Schema 或内部 Analyzer 实现。

## Public Index v1

每次成功索引都会在以下目录生成稳定图导出：

`.context-index/public/v1/`

包含：

- `manifest.json`
- `nodes.jsonl`
- `edges.jsonl`

公共格式为 `cce-public-index`，版本 `1.0.0`。

v1 兼容规则：

- 允许增加字段，读取方必须忽略未知字段；
- 删除已有字段或改变字段语义时必须升级 major version；
- 内部 SQLite schema version 只是生产者元数据，不是公共兼容契约；
- 公共 edge ID 根据稳定的公共 edge 内容生成，不暴露内部 SQLite source row ID。

### 从内部导出迁移

以前直接读取 `symbols.jsonl`、`routes.jsonl` 或 SQLite 内部表的消费者，应迁移到 `public/v1/nodes.jsonl` 和 `public/v1/edges.jsonl`。

示例：

```text
旧内部依赖
  symbols.symbol_id
  edges.source_id
  routes.handler_symbol_id

Public v1
  node.id = "symbol:<symbol-id>"
  edge.from / edge.to
  edge.type / confidence / evidence
```

外部集成不要绑定内部 schema number，应读取 `manifest.format` 和 `manifest.version`。

## SCIP 导出

SCIP 是 Public Index v1 上的适配器，不是 CCE 内部标准图模型。

完成索引后显式执行：

```bash
node src/cli.js export-scip --repo /path/to/repo --out /path/to/index.scip
```

可选指定仓库标识：

```bash
node src/cli.js export-scip --repo /path/to/repo --out ./index.scip --repository my-repo
```

导出器使用官方 Go SCIP bindings，并固定为 `github.com/scip-code/scip/bindings/go/scip v0.9.0`。

当前范围：

- 为已索引 symbol 输出 SCIP `SymbolInformation`；
- 只有在定义行上能够证明 symbol 名称存在唯一、明确的 UTF-8 byte range 时，才输出 definition `Occurrence`；
- 当前 CCE call/reference graph facts 没有完整源码 range，因此不会伪造 call/reference occurrence；
- SCIP 只在显式命令执行时导出，普通 index 不会自动生成。

## Plugin Protocol v1

`src/plugin/v1.js` 定义进程无关的 JSON 协议：

- protocol：`cce-analyzer`
- protocol version：`1`
- fact version：`1.0.0`

Descriptor 声明插件 ID、版本、语言和 capabilities。Analyze request 携带仓库相对路径文件与 tracked files。Result 返回每个文件的状态、symbols、imports/calls dependencies 和 diagnostics。

WP15 **不会自动发现或执行仓库里的第三方插件命令**，也没有“发现 manifest 后自动运行”的路径。未来如果增加执行层，必须要求用户显式配置/授权，并继续执行路径和 fact 校验。

兼容规则：

- 允许新增未知字段；
- 不兼容的 protocol/fact version 直接拒绝；
- 路径必须是仓库相对路径；
- 拒绝重复 file result，以及同一文件内重复 symbol ID；
- 拒绝协议未定义的 dependency relation。

## 验证

执行：

```bash
npm test
npm run benchmark:gate
cd internal/scipexporter && go test ./... && go vet ./...
```

WP15 的兼容测试覆盖 Public Index 确定性/增量字段、Plugin Protocol 正反例，以及 SCIP encode/decode round-trip。
