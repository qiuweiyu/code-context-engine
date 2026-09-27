import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepository } from "../src/context/indexer.js";
import { openStore } from "../src/context/store.js";
import { buildRepositoryFlowManifest } from "../src/context/flow-manifest.js";

const exec = promisify(execFile);

async function write(root, name, body) {
  const full = path.join(root, name);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
}

async function initRepo(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-entry-flow-"));
  for (const [name, body] of Object.entries(files)) await write(root, name, body);
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "add", "."]);
  return root;
}

function rows(root, sql, ...params) {
  const { db } = openStore(path.join(root, ".context-index"));
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

test("Go CLI, cron job and consumer registrations become typed entry flows", async () => {
  const root = await initRepo({
    "cmd/worker/main.go": [
      "package main",
      "",
      "type cronRunner struct{}",
      "func (cronRunner) AddFunc(string, func()) {}",
      "var cron cronRunner",
      "type consumerRunner struct{}",
      "func (consumerRunner) Subscribe(string, func()) {}",
      "var consumer consumerRunner",
      "",
      "func main() {",
      '  cron.AddFunc("@daily", RunCleanup)',
      '  consumer.Subscribe("tasks.created", HandleTask)',
      "}",
      ""
    ].join("\n"),
    "cmd/worker/handlers.go": [
      "package main",
      "",
      "func RunCleanup() { WriteAudit() }",
      "func HandleTask() { WriteAudit() }",
      "func WriteAudit() {",
      '  _ = "INSERT INTO audit_events(id) VALUES (1)"',
      "}",
      ""
    ].join("\n")
  });
  try {
    const indexed = await indexRepository({ repoRoot: root });
    assert.equal(indexed.analysis_failed_files, 0);
    assert.equal(indexed.manifest.schema_version, 9);
    assert.equal(indexed.manifest.counts.entry_points, 3);

    const entries = rows(
      root,
      "SELECT node_id,entry_kind,entry_name,handler_ref,handler_symbol_id FROM entry_points ORDER BY entry_kind,entry_name"
    ).map((row) => ({ ...row }));
    assert.deepEqual(
      entries.map((entry) => [entry.entry_kind, entry.entry_name, entry.handler_ref]),
      [
        ["cli", "main", "main"],
        ["consumer", "tasks.created", "HandleTask"],
        ["job", "@daily", "RunCleanup"]
      ]
    );
    assert.equal(
      entries.find((entry) => entry.entry_kind === "cli").handler_symbol_id,
      "go:cmd/worker/main.go::main"
    );
    assert.equal(
      entries.find((entry) => entry.entry_kind === "job").handler_symbol_id,
      "go:cmd/worker/handlers.go::RunCleanup"
    );
    assert.equal(
      entries.find((entry) => entry.entry_kind === "consumer").handler_symbol_id,
      "go:cmd/worker/handlers.go::HandleTask"
    );

    const job = entries.find((entry) => entry.entry_kind === "job");
    const manifest = buildRepositoryFlowManifest({
      repoRoot: root,
      startNodeIds: [job.node_id],
      maxHops: 4,
      edgeTypes: ["entry_handler", "call", "db_write"]
    });
    assert.equal(manifest.flows[0].entry.kind, "entry");
    assert.equal(manifest.flows[0].entry.entry_kind, "job");
    assert.ok(
      manifest.flows[0].steps.some((step) =>
        step.type === "entry_handler"
        && step.to_node_id === "symbol:go:cmd/worker/handlers.go::RunCleanup"
      )
    );
    assert.ok(
      manifest.flows[0].steps.some((step) =>
        step.type === "db_write"
        && step.to_node_id === "db:table:audit_events"
      )
    );
    assert.deepEqual(
      new Set(manifest.flows[0].files),
      new Set(["cmd/worker/main.go", "cmd/worker/handlers.go"])
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("TypeScript scheduled and queue handlers are static while commented registrations are ignored", async () => {
  const root = await initRepo({
    "src/worker.ts": [
      "function RunDigest() { return 1; }",
      "function HandleEmail() { return 2; }",
      'cron.schedule("*/5 * * * *", RunDigest);',
      'queue.process("emails", HandleEmail);',
      '// queue.process("ghost", GhostHandler);',
      '/* cron.schedule("@hourly", HiddenHandler); */',
      ""
    ].join("\n")
  });
  try {
    const indexed = await indexRepository({ repoRoot: root });
    assert.equal(indexed.analysis_failed_files, 0);
    const entries = rows(
      root,
      "SELECT entry_kind,entry_name,handler_ref,handler_symbol_id FROM entry_points ORDER BY entry_kind,entry_name"
    ).map((row) => ({ ...row }));
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => [entry.entry_kind, entry.entry_name]),
      [["consumer", "emails"], ["job", "*/5 * * * *"]]
    );
    assert.equal(
      entries.find((entry) => entry.entry_kind === "job").handler_symbol_id,
      "typescript:src/worker.ts::RunDigest"
    );
    assert.equal(
      entries.find((entry) => entry.entry_kind === "consumer").handler_symbol_id,
      "typescript:src/worker.ts::HandleEmail"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cross-file TypeScript handlers stay unresolved without import-binding evidence", async () => {
  const root = await initRepo({
    "src/register.ts": 'queue.process("tasks", HandleTask);\n',
    "src/a.ts": "export function HandleTask() { return 'a'; }\n"
  });
  try {
    await indexRepository({ repoRoot: root });
    const entries = rows(
      root,
      "SELECT node_id,handler_symbol_id FROM entry_points"
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].handler_symbol_id, null);
    const edges = rows(
      root,
      "SELECT to_node_id,confidence,evidence_json FROM edges WHERE type='entry_handler'"
    );
    assert.equal(edges.length, 1);
    assert.equal(edges[0].confidence, "unresolved");
    assert.match(edges[0].to_node_id, /^ref:entry_handler:/);
    assert.equal(
      JSON.parse(edges[0].evidence_json).resolution,
      "entry_handler_out_of_scope"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
