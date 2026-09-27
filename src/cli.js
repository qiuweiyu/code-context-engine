#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { indexRepository } from "./context/indexer.js";
import { queryContext, queryContextWithSemantic } from "./context/retriever.js";
import { readIndexStatus } from "./context/status.js";
import { openStore } from "./context/store.js";
import { reviewFeature } from "./context/features.js";
import { exportIndex } from "./context/export.js";
import { buildRepositoryFlowManifest } from "./context/flow-manifest.js";
import { serializeQueryOutput } from "./context/query-output.js";
import { exportScipIndex } from "./public/scip.js";
import { locatePublicNode } from "./public/locate.js";
import { exportGraphHtml } from "./public/graph-html.js";
import { loadCliSemanticProviderSpecV1 } from "./semantic/spec-path.js";

const packageVersion = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function args(name) {
  const values = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === name) values.push(process.argv[i + 1]);
  }
  return values;
}
function has(name) { return process.argv.includes(name); }
function print(value) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }
function usage() {
  process.stderr.write(`Code Context Engine v${packageVersion}\n\nCommands:\n  index --repo <path> [--force]\n  query --repo <path> --task <text> [--max-files 12] [--compact] [--semantic-provider <spec.json>]\n  flow --repo <path> --start <node-id> [--start <node-id>...] [--direction forward|reverse] [--max-hops 3] [--branch-limit 8] [--node-limit 128] [--min-confidence static] [--edge-types entry_handler,api_request,route_handler]\n  locate --repo <path> --node <public-node-id> [--editor vscode|file]\n  graph-html --repo <path> --out <graph.html> [--focus <public-node-id>] [--max-nodes 250] [--max-hops 3]\n  export-scip --repo <path> --out <file.scip> [--repository <name>]\n  status --repo <path>\n  review-feature --repo <path> --feature <id> [--note <text>]\n\nGenerated data lives in <repo>/.context-index. Feature definitions live in <repo>/.context-features/*.json.\n`);
}

const cmd = process.argv[2];
if (!cmd || ["-h","--help","help"].includes(cmd)) { usage(); process.exit(0); }
const repo = path.resolve(arg("--repo", process.cwd()));

try {
  if (cmd === "index") print(await indexRepository({ repoRoot: repo, force: has("--force") }));
  else if (cmd === "query") {
    const task = arg("--task"); if (!task) throw new Error("--task is required");
    const maxFiles = Number(arg("--max-files", "12"));
    const semanticProviderPath = arg("--semantic-provider");
    const result = semanticProviderPath
      ? await queryContextWithSemantic({
        repoRoot: repo,
        task,
        maxFiles,
        semanticProviderSpec: loadCliSemanticProviderSpecV1(semanticProviderPath)
      })
      : queryContext({ repoRoot: repo, task, maxFiles });
    process.stdout.write(serializeQueryOutput(result, { compact: has("--compact") }) + "\n");
  } else if (cmd === "flow") {
    const starts = args("--start");
    if (starts.length === 0) throw new Error("--start is required");
    const rawEdgeTypes = arg("--edge-types");
    print(buildRepositoryFlowManifest({
      repoRoot: repo,
      startNodeIds: starts,
      direction: arg("--direction", "forward"),
      maxHops: Number(arg("--max-hops", "3")),
      branchLimit: Number(arg("--branch-limit", "8")),
      nodeLimit: Number(arg("--node-limit", "128")),
      minConfidence: arg("--min-confidence", "static"),
      edgeTypes: rawEdgeTypes
        ? rawEdgeTypes.split(",").map((value) => value.trim()).filter(Boolean)
        : null
    }));
  } else if (cmd === "locate") {
    const nodeId = arg("--node");
    if (!nodeId) throw new Error("--node is required");
    print(await locatePublicNode({
      repoRoot: repo,
      indexDir: path.join(repo, ".context-index"),
      nodeId,
      editor: arg("--editor", "vscode")
    }));
  } else if (cmd === "graph-html") {
    const out = arg("--out");
    if (!out) throw new Error("--out is required");
    print(await exportGraphHtml({
      repoRoot: repo,
      indexDir: path.join(repo, ".context-index"),
      outFile: path.resolve(out),
      focusNodeId: arg("--focus"),
      maxNodes: Number(arg("--max-nodes", "250")),
      maxHops: Number(arg("--max-hops", "3"))
    }));
  } else if (cmd === "export-scip") {
    const out = arg("--out");
    if (!out) throw new Error("--out is required");
    print(await exportScipIndex({
      repoRoot: repo,
      indexDir: path.join(repo, ".context-index"),
      outFile: path.resolve(out),
      repository: arg("--repository") ?? undefined
    }));
  } else if (cmd === "status") print(readIndexStatus({ repoRoot: repo }));
  else if (cmd === "review-feature") {
    const id = arg("--feature"); if (!id) throw new Error("--feature is required");
    const { db } = openStore(path.join(repo, ".context-index"));
    try { const result = reviewFeature(db, id, arg("--note")); await exportIndex(db, path.join(repo, ".context-index")); print(result); } finally { db.close(); }
  } else throw new Error(`Unknown command: ${cmd}`);
} catch (error) {
  print({ ok:false, error:error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
