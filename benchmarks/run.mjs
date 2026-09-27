#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { indexRepository } from "../src/context/indexer.js";
import { queryContext } from "../src/context/retriever.js";
import { projectQueryOutput } from "../src/context/query-output.js";
import { openStore } from "../src/context/store.js";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(await fs.readFile(path.join(here, "ground-truth.json"), "utf8"));

function key(edge) {
  return JSON.stringify([edge.type, edge.from, edge.to]);
}

function divide(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

async function runCase(spec) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-benchmark-"));
  try {
    await fs.cp(path.join(here, "fixtures", spec.fixture), root, { recursive: true });
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "add", "."]);
    const coldStart = performance.now();
    const first = await indexRepository({ repoRoot: root });
    const coldMs = performance.now() - coldStart;
    const warmStart = performance.now();
    const second = await indexRepository({ repoRoot: root });
    const warmMs = performance.now() - warmStart;
    const { db } = openStore(path.join(root, ".context-index"));
    let actual;
    try {
      actual = new Set(db.prepare("SELECT type,from_node_id,to_node_id FROM edges")
        .all().map((row) => key({ type: row.type, from: row.from_node_id, to: row.to_node_id })));
    } finally {
      db.close();
    }
    const positives = spec.edges.filter((edge) => edge.present);
    const negatives = spec.edges.filter((edge) => !edge.present);
    const tp = positives.filter((edge) => actual.has(key(edge))).length;
    const fn = positives.length - tp;
    const fp = negatives.filter((edge) => actual.has(key(edge))).length;
    const tn = negatives.length - fp;
    const queryStart = performance.now();
    const result = queryContext({ repoRoot: root, task: spec.query, maxFiles: spec.maxFiles ?? 12 });
    const queryMs = performance.now() - queryStart;
    const ranked = [...result.must_read, ...result.maybe_read].map((entry) => entry.path);
    const relevant = new Set(spec.relevantFiles);
    const firstRelevant = ranked.findIndex((name) => relevant.has(name));
    const hitsAt = (k) => ranked.slice(0, k).filter((name) => relevant.has(name)).length;
    const compact = projectQueryOutput(result, { compact: true });
    return {
      name: spec.name,
      fixture: spec.fixture,
      labeled_edges: { tp, fp, fn, tn, precision: divide(tp, tp + fp), recall: divide(tp, tp + fn) },
      retrieval: {
        ranked, relevant: spec.relevantFiles, hit_at_3: hitsAt(3),
        hit_at_5: hitsAt(5), reciprocal_rank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
        coverage_status: result.coverage.status
      },
      performance_ms: {
        cold_index: Number(coldMs.toFixed(2)), warm_index: Number(warmMs.toFixed(2)),
        query: Number(queryMs.toFixed(2))
      },
      indexing: {
        first_changed: first.changed_files, warm_changed: second.changed_files,
        warm_skipped: second.skipped_files
      },
      output_bytes: {
        full: Buffer.byteLength(JSON.stringify(result)),
        compact: Buffer.byteLength(JSON.stringify(compact))
      }
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const cases = [];
for (const spec of corpus.cases) cases.push(await runCase(spec));
const result = { corpus_version: corpus.version, cases };
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (cases.some((entry) => entry.indexing.warm_changed) ||
    (process.argv.includes("--strict") && cases.some((entry) => entry.labeled_edges.fn || entry.labeled_edges.fp))) {
  process.exitCode = 1;
}
