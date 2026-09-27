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

## Install

Recommended public installation:

```powershell
npm install -g code-context-engine
cce --help
```

You can also try the package without a global install:

```powershell
npx code-context-engine --help
```

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
cce index --repo "D:\Path\To\YourProject"
```

A successful result contains:

```json
{ "ok": true }
```

The first run indexes all tracked source files. Go projects also compile a small local helper on first use.

## Inspect status

```powershell
cce status --repo "D:\Path\To\YourProject"
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
├── entry-points.jsonl
├── routes.jsonl
├── tables.jsonl
├── tests.jsonl
├── dependencies.jsonl
└── changes.jsonl
```

Everything under `.context-index` is generated and rebuildable.

## Query by development task

```powershell
cce query --repo "D:\Path\To\YourProject" --task "edit an unpublished manual task"
```

Read `must_read` first, then expand into `maybe_read` only when necessary. A missing result is not proof that a feature does not exist.

The query result also reports `query_expansion.graph_seed_nodes`, `graph_expansion`, and `selection.intent_reserved_files`. CCE can expand from lexical/project-alias seeds through static typed edges such as `entry_handler`, `page_api`, `api_request`, `route_handler`, `call`, `db_read`, `db_write`, and `test_of`. Query traversal is bounded to at most 6 hops and does not traverse unresolved links.

When the task explicitly names multiple surfaces (for example admin UI and miniprogram), graph-discovered files matching those explicit path intents receive a small bounded reservation in final Top-N selection.

For non-HTTP flows, inspect `.context-index/entry-points.jsonl` or query by job/topic name, then pass the returned `node_id` to `flow`:

```powershell
cce flow --repo "D:\Path\To\YourProject" --start "entry:job:cmd/worker/main.go:%40daily:11" --edge-types entry_handler,call,db_read,db_write,test_of
```

WP14 recognizes only bounded static entry forms (for example Go `package main`, direct cron registrations, and direct consumer/queue registrations). Simple TS/JS handlers resolve only within the same file; Go handlers may resolve within the same directory/package. Cross-file TS/JS or otherwise weak/ambiguous handler evidence remains unresolved.

## Project-specific query aliases

If business terms in task descriptions do not match source identifiers, add `.context-query-aliases.json` to the target repository root:

```json
{
  "定向任务": ["manualtask", "manual_task"]
}
```

Aliases are loaded at query time, so changing this file does not require re-indexing.

## Public interoperability

After indexing, the stable external graph export is available at `.context-index/public/v1/`. External consumers should use Public Index v1 instead of binding to internal SQLite tables or internal JSONL files.

To export SCIP explicitly:

```powershell
cce export-scip --repo "D:\Path\To\YourProject" --out "D:\Path\To\index.scip"
```

SCIP export is not automatic. It emits symbol information and only emits definition occurrences when a unique source byte range can be proven. Plugin Protocol v1 defines validated JSON messages only; WP15 does not auto-discover or execute repository plugin commands.

See [INTEROPERABILITY.md](INTEROPERABILITY.md) for Public Index v1 compatibility, migration examples, SCIP scope and Plugin Protocol v1.

## IDE locate and offline graph

Locate a Public Index node without launching an editor:

```powershell
cce locate --repo "D:\Path\To\YourProject" --node "symbol:typescript:src/app.ts::Handle"
```

Generate a self-contained offline graph viewer:

```powershell
cce graph-html --repo "D:\Path\To\YourProject" --out ".\cce-graph.html"
```

Use `--focus <public-node-id> --max-nodes 120 --max-hops 3` for a bounded neighborhood. The viewer reads Public Index v1 only, embeds no repository source text, uses no CDN, and preserves unresolved evidence as unresolved.

See [IDE-GRAPH.md](IDE-GRAPH.md) for the prototype boundary and navigation behavior.

## Incremental workflow

After code changes, run the same index command again:

```powershell
cce index --repo "D:\Path\To\YourProject"
```

Unchanged files are skipped by content hash; changed files are re-indexed. Derived graph edges are rebuilt from the current facts during indexing, so after upgrading CCE logic that changes edge construction, run the normal index command even when `changed_files = 0`; `--force` is not required unless the parser/schema itself requires a full rebuild.

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
cce index --repo "D:\Path\To\YourProject" --force
```

`.context-index` can also be safely deleted and rebuilt:

```powershell
Remove-Item "D:\Path\To\YourProject\.context-index" -Recurse -Force -ErrorAction SilentlyContinue
cce index --repo "D:\Path\To\YourProject"
```

## SQLite warning

Node.js 22 may print `ExperimentalWarning: SQLite is an experimental feature`. CCE currently uses the built-in `node:sqlite`. The warning itself does not mean indexing failed; check the final JSON and `npm test` / CI result.

## Linux / macOS

```bash
npm install -g code-context-engine
cce --help
cce index --repo /path/to/project
cce status --repo /path/to/project
cce query --repo /path/to/project --task "your current task"
```

For contributor/source-checkout setup:

```bash
git clone https://github.com/qiuweiyu/code-context-engine.git
cd code-context-engine
npm install
npm test
```

## Optional Semantic Provider

The default query path is deterministic. A Semantic Provider runs only when explicitly requested:

```bash
cce query \
  --repo /path/to/project \
  --task "find where homework is assigned" \
  --semantic-provider /path/to/provider.json
```

The provider can rerank only the bounded deterministic candidate set. Invalid, crashed or timed-out providers fall back to the deterministic result. See [SEMANTIC-PROVIDER.md](SEMANTIC-PROVIDER.md).

## MCP

Validate CLI index quality first, then connect MCP. Current tools:

- `context_index_repo`
- `context_query`
- `context_index_status`

Start the installed MCP server with the smallest practical filesystem boundary:

```bash
export CCE_ALLOWED_ROOTS=/home/me/projects
code-context-engine-mcp
```

On PowerShell:

```powershell
$env:CCE_ALLOWED_ROOTS = "D:\Projects"
code-context-engine-mcp
```

For current release limits, see [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md).
