#!/usr/bin/env node
import path from "node:path";
import { indexRepository } from "./context/indexer.js";
import { queryContext } from "./context/retriever.js";
import { readIndexStatus } from "./context/status.js";
import { openStore } from "./context/store.js";
import { reviewFeature } from "./context/features.js";
import { exportIndex } from "./context/export.js";
import { buildRepositoryFlowManifest } from "./context/flow-manifest.js";
import { serializeQueryOutput } from "./context/query-output.js";

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
  process.stderr.write(`Code Context Engine v0.1.7\n\nCommands:\n  index --repo <path> [--force]\n  query --repo <path> --task <text> [--max-files 12] [--compact]\n  flow --repo <path> --start <node-id> [--start <node-id>...] [--direction forward|reverse] [--max-hops 3] [--branch-limit 8] [--node-limit 128] [--min-confidence static] [--edge-types api_request,route_handler]\n  status --repo <path>\n  review-feature --repo <path> --feature <id> [--note <text>]\n\nGenerated data lives in <repo>/.context-index. Feature definitions live in <repo>/.context-features/*.json.\n`);
}

const cmd = process.argv[2];
if (!cmd || ["-h","--help","help"].includes(cmd)) { usage(); process.exit(0); }
const repo = path.resolve(arg("--repo", process.cwd()));

try {
  if (cmd === "index") print(await indexRepository({ repoRoot: repo, force: has("--force") }));
  else if (cmd === "query") {
    const task = arg("--task"); if (!task) throw new Error("--task is required");
    const result = queryContext({ repoRoot: repo, task, maxFiles: Number(arg("--max-files", "12")) });
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
