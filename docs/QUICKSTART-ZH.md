# Code Context Engine 快速开始

[English](QUICKSTART.md) | [中文](QUICKSTART-ZH.md)

CCE 的核心索引过程完全在本地运行，不依赖大模型，也不会上传源码。

## 环境要求

- Node.js 22.13+
- Git
- 如果分析 Go 项目，还需要 Go

```powershell
node -v
npm -v
git --version
go version
```

## Windows PowerShell 安装

建议把 CCE 作为独立开发工具安装，不要直接放进业务项目。

```powershell
New-Item -ItemType Directory -Force D:\Tools | Out-Null
cd D:\Tools
git clone https://github.com/qiuweiyu/code-context-engine.git
cd D:\Tools\code-context-engine
npm install
npm test
```

`npm test` 通过后，再用于真实项目。

## 避免生成数据污染业务仓库 Git 状态

CCE 默认在目标项目根目录生成 `.context-index/`。

首次本地试用建议写入 `.git/info/exclude`，不要立刻修改项目共享的 `.gitignore`：

```powershell
$repo = "D:\Path\To\YourProject"
$exclude = Join-Path $repo ".git\info\exclude"

if (-not (Select-String -Path $exclude -Pattern '^\.context-index/$' -Quiet -ErrorAction SilentlyContinue)) {
    Add-Content -Path $exclude -Value ".context-index/"
}
```

## 第一次建立索引

```powershell
cd D:\Tools\code-context-engine
node .\src\cli.js index --repo "D:\Path\To\YourProject"
```

成功结果应包含：

```json
{ "ok": true }
```

第一次会扫描全部 Git tracked source。如果项目包含 Go，首次运行还会编译一个本地 Go helper，后续复用缓存。

## 查看索引状态

```powershell
node .\src\cli.js status --repo "D:\Path\To\YourProject"
Get-Content "D:\Path\To\YourProject\.context-index\manifest.json"
```

## 生成的数据

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

这些都属于可删除、可重建的生成数据。

- `index.sqlite`：主要查询数据库
- `symbols.jsonl`：函数、方法、参数、返回值、文件位置、行号和 hash
- `dependencies.jsonl`：import / call 等依赖关系
- `routes.jsonl`：HTTP Route
- `tables.jsonl`：数据库对象和 SQL 操作
- `tests.jsonl`：测试与源码映射
- `changes.jsonl`：索引变化事件
- `manifest.json`：整体统计摘要

## 根据开发任务查询相关代码

```powershell
node .\src\cli.js query --repo "D:\Path\To\YourProject" --task "编辑未发布的人工任务"
```

建议先读取 `must_read`，上下文不足时再看 `maybe_read`。查询没有命中，不代表功能一定不存在。


## 项目业务词别名

如果需求描述中的业务词与源码英文命名没有直接词法关系，可以在项目根目录增加：

```text
.context-query-aliases.json
```

例如：

```json
{
  "定向任务": ["manualtask", "manual_task"],
  "宠物成长": ["petgrowth", "pet_growth"]
}
```

别名在执行 `query` 时读取，因此修改这个文件后不需要重新建立索引。

## 日常增量索引

代码修改后重新执行同一个命令：

```powershell
node .\src\cli.js index --repo "D:\Path\To\YourProject"
```

CCE 会比较内容 hash：未变化文件直接 `skipped`，只重新分析变化文件。

推荐日常流程：

```text
更新 CCE
→ npm test
→ index 项目
→ status / manifest
→ query 当前开发任务
→ 修改代码
→ 再次 index
→ query / test
```

## 全量重建

正常情况下不需要 `--force`。只有 parser 升级、调试索引或明确验证完整重建时使用：

```powershell
node .\src\cli.js index --repo "D:\Path\To\YourProject" --force
```

也可以安全删除 `.context-index` 后重建：

```powershell
Remove-Item "D:\Path\To\YourProject\.context-index" -Recurse -Force -ErrorAction SilentlyContinue
node .\src\cli.js index --repo "D:\Path\To\YourProject"
```

## SQLite ExperimentalWarning

Node.js 22 可能显示 `ExperimentalWarning: SQLite is an experimental feature`。CCE 当前使用内置 `node:sqlite`。这个提示本身不代表失败，应以最终 JSON 的 `ok: true`、`npm test` 和 CI 结果为准。

## Linux / macOS

```bash
git clone https://github.com/qiuweiyu/code-context-engine.git
cd code-context-engine
npm install
npm test
node ./src/cli.js index --repo /path/to/project
node ./src/cli.js status --repo /path/to/project
node ./src/cli.js query --repo /path/to/project --task "your current task"
```

## MCP

建议先用 CLI 验证索引质量，再接入 MCP。当前工具：

- `context_index_repo`
- `context_query`
- `context_index_status`
