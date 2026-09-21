# Code Context Engine Quick Start

[English](QUICKSTART.md) | [中文](QUICKSTART-ZH.md)

CCE runs locally, does not require an LLM, and does not upload source code.

## Requirements

- Node.js 22.13+
- Git
- Go when indexing Go projects

```bash
node -v
npm -v
git --version
go version
```

## Windows PowerShell install

Keep CCE separate from the application repository:

```powershell
New-Item -ItemType Directory -Force D:\Tools | Out-Null
cd D:\Tools
git clone https://github.com/qiuweiyu/code-context-engine.git
cd D:\Tools\code-context-engine
npm install
npm test
```

Only continue to a real repository after the test suite passes.

## Keep generated data out of Git status

CCE writes generated data to `.context-index/` inside the target repository.

For a local trial, add it to `.git/info/exclude` instead of changing the shared `.gitignore`:

```powershell
$repo = "D:\Path\To\YourProject"
$exclude = Join-Path $repo ".git\info\exclude"

if (-not (Select-String -Path $exclude -Pattern '^\.context-index/$' -Quiet -ErrorAction SilentlyContinue)) {
    Add-Content -Path $exclude -Value ".context-index/"
}
```

## First index

```powershell
cd D:\Tools\code-context-engine
node .\src\cli.js index --repo "D:\Path\To\YourProject"
```

A successful result contains:

```json
{ "ok": true }
```

The first run indexes all tracked source files. Go projects also compile a small local helper on first use.

## Inspect status

```powershell
node .\src\cli.js status --repo "D:\Path\To\YourProject"
Get-Content "D:\Path\To\YourProject\.context-index\manifest.json"
```

## Generated files

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

Everything under `.context-index` is generated and rebuildable.

## Query by development task

```powershell
node .\src\cli.js query --repo "D:\Path\To\YourProject" --task "edit an unpublished manual task"
```

Read `must_read` first, then expand into `maybe_read` only when necessary. A missing result is not proof that a feature does not exist.


## Project-specific query aliases

If business terms in task descriptions do not match source identifiers, add `.context-query-aliases.json` to the target repository root:

```json
{
  "定向任务": ["manualtask", "manual_task"]
}
```

Aliases are loaded at query time, so changing this file does not require re-indexing.

## Incremental workflow

After code changes, run the same index command again:

```powershell
node .\src\cli.js index --repo "D:\Path\To\YourProject"
```

Unchanged files are skipped by content hash; changed files are re-indexed.

Recommended daily cycle:

```text
git pull CCE
→ npm test
→ index project
→ status / manifest
→ query current task
→ edit code
→ index again
→ query / test
```

## Full rebuild

Normally you do not need `--force`. Use it only for parser upgrades or explicit rebuild verification:

```powershell
node .\src\cli.js index --repo "D:\Path\To\YourProject" --force
```

`.context-index` can also be safely deleted and rebuilt:

```powershell
Remove-Item "D:\Path\To\YourProject\.context-index" -Recurse -Force -ErrorAction SilentlyContinue
node .\src\cli.js index --repo "D:\Path\To\YourProject"
```

## SQLite warning

Node.js 22 may print `ExperimentalWarning: SQLite is an experimental feature`. CCE currently uses the built-in `node:sqlite`. The warning itself does not mean indexing failed; check the final JSON and `npm test` / CI result.

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

Validate CLI index quality first, then connect MCP. Current tools:

- `context_index_repo`
- `context_query`
- `context_index_status`
