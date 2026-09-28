#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateAgentExperiment } from "../src/observability/agent-experiment.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputs = process.argv.slice(2);
if (inputs.length > 10 || inputs.some((name) => name.startsWith("-"))) {
  process.stderr.write("Usage: node scripts/agent-experiment-report.mjs [private-record.json ...]\n");
  process.exitCode = 2;
} else {
  try {
    const cases = [];
    for (const name of inputs) {
      const absolute = path.resolve(name);
      const actual = await fs.realpath(absolute);
      const rel = path.relative(root, actual);
      if (rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))) {
        throw new Error("experiment input must be stored outside the repository");
      }
      const metadata = await fs.lstat(absolute);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2 * 1024 * 1024) {
        throw new Error("invalid experiment file");
      }
      const data = JSON.parse(await fs.readFile(absolute, "utf8"));
      // No capture adapter is connected. A manual record or unchecked export can
      // only produce observational diagnostics, never Controlled Experiment metrics.
      cases.push(evaluateAgentExperiment(data));
    }
    const ids = cases.map((entry) => entry.task_id);
    if (new Set(ids).size !== ids.length) throw new Error("duplicate task id");
    process.stdout.write(JSON.stringify({
      schema_version: 1,
      status: cases.length ? "observational" : "unavailable",
      reason: cases.length ? "verified_agent_capture_unavailable" : "no_agent_experiment_inputs",
      task_count: cases.length,
      cases
    }, null, 2) + "\n");
  } catch (error) {
    // Parse errors can include private input values, so never print error.message.
    process.stderr.write("Invalid or unsafe private experiment record; no report produced.\n");
    process.exitCode = 1;
  }
}
