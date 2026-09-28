import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateAgentExperiment, agentExperimentSchema } from "../src/observability/agent-experiment.js";

const digest = createHash("sha256").update("task without source").digest("hex");
const head = "a".repeat(40);
const sessionWithout = "11111111-1111-4111-8111-111111111111";
const sessionWith = "22222222-2222-4222-8222-222222222222";
function pair() {
  return {
    schema_version: 1, task_id: "cli_version", task_fingerprint: digest,
    rubric_id: "cli_version_rubric", repository_head: head,
    agent: { name: "codex", model: "same-model", version: "same-version" },
    runs: [
      {
        arm: "without_cce", session_id: sessionWithout, order: 1,
        repository_head: head, outcome: "success",
        capture: { kind: "manual", complete: true, evidence_file: null, evidence_sha256: null },
        operations: [
          { type: "search" }, { type: "search" },
          { type: "read", path: "src/cli.js", bytes: 100 },
          { type: "read", path: "src/cli.js", bytes: 100 },
          { type: "read", path: "package.json", bytes: 40 },
          { type: "edit", path: "src/cli.js" }
        ],
        selection: null, usage: { source: "agent_reported", input_tokens: 200 }
      },
      {
        arm: "with_cce", session_id: sessionWith, order: 2,
        repository_head: head, outcome: "success",
        capture: { kind: "manual", complete: true, evidence_file: null, evidence_sha256: null },
        operations: [
          { type: "cce_query" }, { type: "search" },
          { type: "read", path: "src/cli.js", bytes: 100 },
          { type: "read", path: "src/server.js", bytes: 50 },
          { type: "edit", path: "src/cli.js" }
        ],
        selection: {
          must_read: ["src/cli.js"], maybe_read: ["package.json"], tests: ["test/cli-version.test.mjs"]
        },
        usage: { source: "agent_reported", input_tokens: 250 }
      }
    ]
  };
}
test("paired run reports operations and selection overlap without exposing paths or claiming tokens", () => {
  const report = evaluateAgentExperiment(pair());
  assert.equal(report.status, "observational");
  assert.deepEqual(report.token_comparison,
    { status: "unavailable", reason: "verified_agent_exports_required" });
  assert.equal(report.without_cce.source_bytes_read, 240);
  assert.equal(report.without_cce.files_read, 2);
  assert.equal(report.without_cce.search_operations, 2);
  assert.equal(report.with_cce.source_bytes_read, 150);
  assert.equal(report.with_cce.cce_queries, 1);
  assert.deepEqual(report.selected_path_diagnostics,
    { selected_and_read: 1, selected_not_read: 2, read_not_selected: 1 });
  assert.equal(JSON.stringify(report).includes("src/cli.js"), false);
  assert.equal(JSON.stringify(report).includes("task without source"), false);
});
test("unit verified exports can report a negative Controlled Experiment delta", () => {
  const record = pair();
  for (const run of record.runs) {
    run.capture = {
      kind: "agent_export", complete: true,
      evidence_file: run.arm + ".jsonl", evidence_sha256: digest
    };
  }
  assert.equal(evaluateAgentExperiment(record).status, "observational");
  const verifiedSessions = new Set([sessionWithout, sessionWith]);
  const report = evaluateAgentExperiment(record, { verifiedSessions });
  assert.equal(report.status, "controlled_experiment");
  assert.equal(report.token_comparison.measurement_source, "controlled_experiment");
  assert.equal(report.token_comparison.difference_tokens, -50);
  record.runs[1].usage = null;
  assert.equal(evaluateAgentExperiment(record, { verifiedSessions })
    .token_comparison.reason, "agent_token_usage_unavailable");
  record.runs[1].outcome = "failure";
  assert.equal(evaluateAgentExperiment(record, { verifiedSessions })
    .token_comparison.reason, "task_outcome_mismatch");
});
test("record validation rejects unsafe paths, arbitrary source fields and contaminated pairs", () => {
  for (const file of ["../secret.js", ".env.test", "keys/id_rsa", "cert/server.key", "C:/private/app.js", ".GIT/config", "src/bad\nfile.js"]) {
    const record = pair();
    record.runs[1].operations[2].path = file;
    assert.throws(() => agentExperimentSchema.parse(record), { name: "ZodError" });
  }
  const withSource = pair();
  withSource.source = "private source body";
  assert.throws(() => agentExperimentSchema.parse(withSource), { name: "ZodError" });
  const badPair = pair();
  badPair.runs[1].repository_head = "b".repeat(40);
  assert.throws(() => agentExperimentSchema.parse(badPair), { name: "ZodError" });
  const contaminated = pair();
  contaminated.runs[0].operations.push({ type: "cce_query" });
  assert.throws(() => agentExperimentSchema.parse(contaminated), { name: "ZodError" });
  const duplicated = pair();
  duplicated.runs[1].session_id = sessionWithout;
  assert.throws(() => agentExperimentSchema.parse(duplicated), { name: "ZodError" });
  const unverified = pair();
  unverified.runs[1].capture.kind = "agent_export";
  assert.throws(() => agentExperimentSchema.parse(unverified), { name: "ZodError" });
});
test("no input never produces fabricated experiments", () => {
  const output = JSON.parse(execFileSync(process.execPath,
    ["scripts/agent-experiment-report.mjs"], { encoding: "utf8" }));
  assert.deepEqual(output, {
    schema_version: 1, status: "unavailable", reason: "no_agent_experiment_inputs",
    task_count: 0, cases: []
  });
});

test("private CLI input remains observational, omits paths, and does not leak invalid source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cce-agent-experiment-"));
  try {
    const input = path.join(dir, "private-record.json");
    fs.writeFileSync(input, JSON.stringify(pair()));
    const valid = JSON.parse(execFileSync(process.execPath,
      ["scripts/agent-experiment-report.mjs", input], { encoding: "utf8" }));
    assert.equal(valid.task_count, 1);
    assert.equal(valid.status, "observational");
    assert.equal(valid.cases[0].token_comparison.status, "unavailable");
    assert.equal(JSON.stringify(valid).includes("src/cli.js"), false);
    assert.equal(JSON.stringify(valid).includes(input), false);
    const invalid = pair();
    invalid.source = "private credential canary";
    fs.writeFileSync(input, JSON.stringify(invalid));
    const failure = spawnSync(process.execPath,
      ["scripts/agent-experiment-report.mjs", input], { encoding: "utf8" });
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, "");
    assert.equal(failure.stderr.includes("private credential canary"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Agent may choose not to call available CCE; selection diagnostics stay unavailable", () => {
  const record = pair();
  record.runs[1].selection = null;
  record.runs[1].operations = record.runs[1].operations.filter((entry) => entry.type !== "cce_query");
  const report = evaluateAgentExperiment(record);
  assert.equal(report.with_cce.cce_queries, 0);
  assert.equal(report.selected_path_diagnostics, null);
  assert.equal(report.token_comparison.status, "unavailable");
  record.runs[1].operations.push({ type: "cce_query" });
  assert.throws(() => agentExperimentSchema.parse(record), { name: "ZodError" });
});
