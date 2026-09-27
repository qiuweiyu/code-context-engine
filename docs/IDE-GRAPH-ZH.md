# CCE IDE 与图可视化原型

WP16 在 **Public Index v1** 之上增加两个本地消费者。两个消费者都不读取 CCE 内部 SQLite 表。

## 定位公共节点

完成索引后：

```bash
node src/cli.js locate --repo /path/to/repo --node "symbol:typescript:src/app.ts::Handle"
```

默认结果会提供 `vscode://file` URI。如果希望首选普通本地 file URI：

```bash
node src/cli.js locate --repo /path/to/repo --node "symbol:typescript:src/app.ts::Handle" --editor file
```

当前支持的源码定位依据：

- document -> 第 1 行；
- symbol -> 已索引定义行；
- entry -> 注册行；
- route / data object -> Public Index 中一个或多个 observation；
- reference / unknown -> 不伪造源码位置。

该命令**不会自动启动编辑器**，只返回本地导航 URI。

## 生成离线图查看器

```bash
node src/cli.js graph-html --repo /path/to/repo --out ./cce-graph.html
```

也可以聚焦一个 Public Index 节点，只导出有界邻域：

```bash
node src/cli.js graph-html \
  --repo /path/to/repo \
  --out ./cce-flow.html \
  --focus "entry:job:cmd/worker/main.go:%40daily:11" \
  --max-nodes 120 \
  --max-hops 3
```

输出是一个自包含 HTML 文件：

- 不使用 CDN；
- 不加载外部 JavaScript 或样式表；
- 不需要服务端；
- 不上传源码；
- 布局确定性；
- 支持节点搜索；
- 支持按 edge type 过滤；
- 可查看节点及 evidence；
- 提供本地源码链接；
- unresolved edge 保持明确的 unresolved 展示，不提升为 static。

查看器只嵌入 Public Index 图事实和导航元数据，不嵌入仓库源码正文。

## 原型边界

WP16 不是完整 IDE 扩展。它的目标是证明 Public Index v1 能够支持真实外部消费者，而无需 import CCE 内部 store/schema。后续 VS Code 或其他编辑器集成可以复用同一套 locate/view-model 模块。

验收命令：

```bash
npm test
npm run benchmark:gate
```
