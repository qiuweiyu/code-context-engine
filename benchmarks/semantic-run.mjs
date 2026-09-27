#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { indexRepository } from "../src/context/indexer.js";
import {
  queryContext,
  queryContextWithSemantic
} from "../src/context/retriever.js";
import { projectQueryOutput } from "../src/context/query-output.js";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  await fs.readFile(path.join(here, "semantic-ground-truth.json"), "utf8")
);
const rawSpec = JSON.parse(
  await fs.readFile(path.join(here, "semantic-provider.json"), "utf8")
);
const providerSpec = {
  ...rawSpec,
  command: process.execPath,
  args: rawSpec.args.map((arg) => path.resolve(here, "..", arg))
};

function selectedPaths(result) {
  return [...(result.must_read ?? []), ...(result.maybe_read ?? [])]
    .map((entry) => entry.path);
}

function retrievalMetrics(result, relevantFiles) {
  const ranked = selectedPaths(result);
  const relevant = new Set(relevantFiles);
  const firstRelevant = ranked.findIndex((file) => relevant.has(file));
  const hitsAt = (k) => ranked.slice(0, k)
    .filter((file) => relevant.has(file))
    .length;
  return {
    ranked,
    relevant: relevantFiles,
    hit_at_1: hitsAt(1),
    hit_at_3: hitsAt(3),
    hit_at_5: hitsAt(5),
    selected_relevant: ranked.filter((file) => relevant.has(file)).length,
    reciprocal_rank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1)
  };
}

function outputBytes(result) {
  return {
    full: Buffer.byteLength(JSON.stringify(result)),
    compact: Buffer.byteLength(JSON.stringify(
      projectQueryOutput(result, { compact: true })
    ))
  };
}

async function timed(fn, samples = 3) {
  const durations = [];
  let last;
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    last = await fn();
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  return {
    result: last,
    median_ms: Number(durations[Math.floor(durations.length / 2)].toFixed(2)),
    min_ms: Number(durations[0].toFixed(2)),
    max_ms: Number(durations.at(-1).toFixed(2))
  };
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-semantic-benchmark-"));
try {
  await fs.cp(path.join(here, "fixtures", corpus.fixture), root, { recursive: true });
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "add", "."]);
  await indexRepository({ repoRoot: root });

  const cases = [];
  for (const spec of corpus.cases) {
    const queryOptions = {
      repoRoot: root,
      task: spec.query,
      maxFiles: spec.maxFiles ?? corpus.maxFiles ?? 3
    };

    const off = await timed(() => Promise.resolve(queryContext(queryOptions)));
    const on = await timed(() => queryContextWithSemantic({
      ...queryOptions,
      semanticProviderSpec: providerSpec
    }));

    cases.push({
      name: spec.name,
      query: spec.query,
      relevant_files: spec.relevantFiles,
      off: {
        retrieval: retrievalMetrics(off.result, spec.relevantFiles),
        performance_ms: {
          median: off.median_ms,
          min: off.min_ms,
          max: off.max_ms
        },
        output_bytes: outputBytes(off.result)
      },
      on: {
        retrieval: retrievalMetrics(on.result, spec.relevantFiles),
        performance_ms: {
          median: on.median_ms,
          min: on.min_ms,
          max: on.max_ms
        },
        output_bytes: outputBytes(on.result),
        semantic_refinement: {
          status: on.result.semantic_refinement?.status ?? null,
          provider: on.result.semantic_refinement?.provider?.id ?? null,
          candidate_count: on.result.semantic_refinement?.candidate_count ?? 0,
          provider_duration_ms: on.result.semantic_refinement?.duration_ms ?? null
        }
      }
    });
  }

  const summaryFor = (mode) => ({
    hit_at_1_cases: cases.reduce((sum, item) => sum + Number(item[mode].retrieval.hit_at_1 > 0), 0),
    hit_at_3_cases: cases.reduce((sum, item) => sum + Number(item[mode].retrieval.hit_at_3 > 0), 0),
    hit_at_5_cases: cases.reduce((sum, item) => sum + Number(item[mode].retrieval.hit_at_5 > 0), 0),
    selected_relevant: cases.reduce((sum, item) => sum + item[mode].retrieval.selected_relevant, 0),
    mrr: Number(average(cases.map((item) => item[mode].retrieval.reciprocal_rank)).toFixed(4)),
    median_query_ms_avg: Number(average(cases.map((item) => item[mode].performance_ms.median)).toFixed(2)),
    compact_bytes_total: cases.reduce((sum, item) => sum + item[mode].output_bytes.compact, 0),
    full_bytes_total: cases.reduce((sum, item) => sum + item[mode].output_bytes.full, 0)
  });

  const offSummary = summaryFor("off");
  const onSummary = summaryFor("on");
  const result = {
    corpus_version: corpus.version,
    fixture: corpus.fixture,
    cases,
    summary: {
      off: offSummary,
      on: onSummary,
      delta: {
        hit_at_1_cases: onSummary.hit_at_1_cases - offSummary.hit_at_1_cases,
        hit_at_3_cases: onSummary.hit_at_3_cases - offSummary.hit_at_3_cases,
        hit_at_5_cases: onSummary.hit_at_5_cases - offSummary.hit_at_5_cases,
        selected_relevant: onSummary.selected_relevant - offSummary.selected_relevant,
        mrr: Number((onSummary.mrr - offSummary.mrr).toFixed(4)),
        median_query_ms_avg: Number(
          (onSummary.median_query_ms_avg - offSummary.median_query_ms_avg).toFixed(2)
        ),
        compact_bytes_total: onSummary.compact_bytes_total - offSummary.compact_bytes_total,
        full_bytes_total: onSummary.full_bytes_total - offSummary.full_bytes_total
      }
    }
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
