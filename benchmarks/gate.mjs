#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const thresholds = JSON.parse(
  await fs.readFile(path.join(here, "quality-gate.json"), "utf8")
);

let stdout;
try {
  ({ stdout } = await exec(process.execPath, ["benchmarks/run.mjs"], {
    cwd: root,
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024
  }));
} catch (error) {
  if (!error.stdout) throw error;
  stdout = error.stdout;
}

const report = JSON.parse(stdout);
const violations = [];
const add = (condition, message) => {
  if (!condition) violations.push(message);
};

const totals = report.cases.reduce((acc, item) => {
  acc.tp += item.labeled_edges.tp;
  acc.fp += item.labeled_edges.fp;
  acc.fn += item.labeled_edges.fn;
  acc.compact += item.output_bytes.compact;
  return acc;
}, { tp: 0, fp: 0, fn: 0, compact: 0 });

add(
  report.corpus_version === thresholds.corpus_version,
  `corpus version ${report.corpus_version} != ${thresholds.corpus_version}`
);
add(
  report.cases.length === thresholds.case_count,
  `case count ${report.cases.length} != ${thresholds.case_count}`
);
add(totals.tp >= thresholds.min_tp, `TP ${totals.tp} < ${thresholds.min_tp}`);
add(totals.fp <= thresholds.max_fp, `FP ${totals.fp} > ${thresholds.max_fp}`);
add(totals.fn <= thresholds.max_fn, `FN ${totals.fn} > ${thresholds.max_fn}`);
add(
  totals.compact <= thresholds.max_total_compact_bytes,
  `Compact bytes ${totals.compact} > ${thresholds.max_total_compact_bytes}`
);

for (const item of report.cases) {
  const prefix = item.name;
  const relevant = item.retrieval.relevant.length;
  const hitRatio = relevant ? item.retrieval.hit_at_5 / relevant : 1;
  const compactRatio = item.output_bytes.full
    ? item.output_bytes.compact / item.output_bytes.full
    : 1;

  add(
    item.indexing.warm_changed <= thresholds.max_warm_changed_per_case,
    `${prefix}: warm_changed ${item.indexing.warm_changed}`
  );
  add(
    item.retrieval.coverage_status === "sufficient",
    `${prefix}: coverage_status ${item.retrieval.coverage_status}`
  );
  add(
    hitRatio >= thresholds.min_hit_at_5_ratio,
    `${prefix}: Hit@5 ratio ${hitRatio.toFixed(3)} < ${thresholds.min_hit_at_5_ratio}`
  );
  add(
    item.output_bytes.compact < item.output_bytes.full,
    `${prefix}: Compact output is not smaller than Full`
  );
  add(
    compactRatio <= thresholds.max_compact_full_ratio,
    `${prefix}: Compact/Full ${compactRatio.toFixed(3)} > ${thresholds.max_compact_full_ratio}`
  );
  add(
    item.performance_ms.cold_index <= thresholds.max_case_cold_ms,
    `${prefix}: cold ${item.performance_ms.cold_index}ms > ${thresholds.max_case_cold_ms}ms`
  );
  add(
    item.performance_ms.warm_index <= thresholds.max_case_warm_ms,
    `${prefix}: warm ${item.performance_ms.warm_index}ms > ${thresholds.max_case_warm_ms}ms`
  );
  add(
    item.performance_ms.query <= thresholds.max_case_query_ms,
    `${prefix}: query ${item.performance_ms.query}ms > ${thresholds.max_case_query_ms}ms`
  );
}

const summary = {
  corpus_version: report.corpus_version,
  cases: report.cases.length,
  tp: totals.tp,
  fp: totals.fp,
  fn: totals.fn,
  compact_bytes: totals.compact,
  max_cold_ms: Math.max(...report.cases.map((x) => x.performance_ms.cold_index)),
  max_warm_ms: Math.max(...report.cases.map((x) => x.performance_ms.warm_index)),
  max_query_ms: Math.max(...report.cases.map((x) => x.performance_ms.query))
};

console.log(JSON.stringify(summary, null, 2));
if (violations.length) {
  console.error("CCE benchmark gate failed:");
  for (const message of violations) console.error("- " + message);
  process.exitCode = 1;
} else {
  console.log("CCE benchmark gate PASS");
}
