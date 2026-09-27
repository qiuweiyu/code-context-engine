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
  await fs.readFile(path.join(here, "semantic-quality-gate.json"), "utf8")
);

const { stdout } = await exec(process.execPath, ["benchmarks/semantic-run.mjs"], {
  cwd: root,
  timeout: 120000,
  maxBuffer: 4 * 1024 * 1024
});
const report = JSON.parse(stdout);
const violations = [];
const requireGate = (condition, message) => {
  if (!condition) violations.push(message);
};

const appliedCases = report.cases.filter(
  (item) => item.on.semantic_refinement.status === "applied"
).length;

requireGate(
  report.corpus_version === thresholds.corpus_version,
  `corpus version ${report.corpus_version} != ${thresholds.corpus_version}`
);
requireGate(
  report.cases.length === thresholds.case_count,
  `case count ${report.cases.length} != ${thresholds.case_count}`
);
requireGate(
  appliedCases >= thresholds.min_applied_provider_cases,
  `applied provider cases ${appliedCases} < ${thresholds.min_applied_provider_cases}`
);
requireGate(
  report.summary.on.hit_at_5_cases >= thresholds.min_on_hit_at_5_cases,
  `ON Hit@5 cases ${report.summary.on.hit_at_5_cases} < ${thresholds.min_on_hit_at_5_cases}`
);
requireGate(
  report.summary.delta.hit_at_3_cases >= thresholds.min_hit_at_3_delta,
  `Hit@3 delta ${report.summary.delta.hit_at_3_cases} < ${thresholds.min_hit_at_3_delta}`
);
requireGate(
  report.summary.delta.selected_relevant >= thresholds.min_selected_relevant_delta,
  `selected relevant delta ${report.summary.delta.selected_relevant} < ${thresholds.min_selected_relevant_delta}`
);
requireGate(
  report.summary.delta.mrr >= thresholds.min_mrr_delta,
  `MRR delta ${report.summary.delta.mrr} < ${thresholds.min_mrr_delta}`
);
requireGate(
  report.summary.delta.compact_bytes_total <= thresholds.max_compact_bytes_delta,
  `compact byte delta ${report.summary.delta.compact_bytes_total} > ${thresholds.max_compact_bytes_delta}`
);
requireGate(
  report.summary.on.median_query_ms_avg <= thresholds.max_on_median_query_ms_avg,
  `ON median query average ${report.summary.on.median_query_ms_avg}ms > ${thresholds.max_on_median_query_ms_avg}ms`
);

const summary = {
  corpus_version: report.corpus_version,
  cases: report.cases.length,
  provider_applied: appliedCases,
  off: {
    hit_at_1_cases: report.summary.off.hit_at_1_cases,
    hit_at_3_cases: report.summary.off.hit_at_3_cases,
    hit_at_5_cases: report.summary.off.hit_at_5_cases,
    selected_relevant: report.summary.off.selected_relevant,
    mrr: report.summary.off.mrr,
    median_query_ms_avg: report.summary.off.median_query_ms_avg,
    compact_bytes_total: report.summary.off.compact_bytes_total
  },
  on: {
    hit_at_1_cases: report.summary.on.hit_at_1_cases,
    hit_at_3_cases: report.summary.on.hit_at_3_cases,
    hit_at_5_cases: report.summary.on.hit_at_5_cases,
    selected_relevant: report.summary.on.selected_relevant,
    mrr: report.summary.on.mrr,
    median_query_ms_avg: report.summary.on.median_query_ms_avg,
    compact_bytes_total: report.summary.on.compact_bytes_total
  },
  delta: report.summary.delta
};

console.log(JSON.stringify(summary, null, 2));
if (violations.length) {
  console.error("CCE semantic benchmark gate failed:");
  for (const message of violations) console.error("- " + message);
  process.exitCode = 1;
} else {
  console.log("CCE semantic benchmark gate PASS");
}
