# CCE IDE & Graph Prototype

WP16 adds two local consumers on top of **Public Index v1**. Neither consumer reads CCE's internal SQLite tables.

## Locate a public node

After indexing:

```bash
node src/cli.js locate --repo /path/to/repo --node "symbol:typescript:src/app.ts::Handle"
```

By default the result contains a `vscode://file` URI. To return the ordinary local file URI as the preferred link:

```bash
node src/cli.js locate --repo /path/to/repo --node "symbol:typescript:src/app.ts::Handle" --editor file
```

Supported source evidence:

- document -> line 1;
- symbol -> indexed definition line;
- entry -> registration line;
- route/data object -> one or more Public Index observations;
- reference/unknown -> no fabricated location.

The command **does not launch an editor**. It only returns local navigation URIs.

## Generate an offline graph viewer

```bash
node src/cli.js graph-html --repo /path/to/repo --out ./cce-graph.html
```

Focus on one public node and keep only a bounded neighborhood:

```bash
node src/cli.js graph-html \
  --repo /path/to/repo \
  --out ./cce-flow.html \
  --focus "entry:job:cmd/worker/main.go:%40daily:11" \
  --max-nodes 120 \
  --max-hops 3
```

The output is one self-contained HTML file:

- no CDN;
- no external JavaScript or stylesheet;
- no server required;
- no source upload;
- deterministic layout;
- node search;
- edge-type filters;
- node/evidence details;
- local source links;
- unresolved edges remain visibly unresolved.

The viewer embeds Public Index graph facts and navigation metadata, not repository source text.

## Prototype boundary

WP16 is intentionally not a full IDE extension. It proves that Public Index v1 can support real external consumers without importing the internal store/schema. A future VS Code/other editor integration can reuse the same locate/view-model modules.

Run the acceptance suite with:

```bash
npm test
npm run benchmark:gate
```
