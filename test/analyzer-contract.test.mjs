import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepository } from "../src/context/indexer.js";
import { openStore } from "../src/context/store.js";
import { readIndexStatus } from "../src/context/status.js";
import { queryContext } from "../src/context/retriever.js";
import { projectQueryOutput } from "../src/context/query-output.js";
import {
  ANALYZER_CONTRACT_VERSION, analyzerFor, parserVersionFor,
  createAnalyzerRegistry, analyzePendingFiles
} from "../src/context/analyzers.js";

const exec = promisify(execFile);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-analyzer-contract-"));
  await fs.writeFile(path.join(root, "service.go"), "package fixture\nfunc Alpha() {}\n");
  await fs.writeFile(path.join(root, "client.ts"), "export function beta() { return 1; }\n");
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "add", "."]);
  return root;
}

function symbols(root) {
  const { db } = openStore(path.join(root, ".context-index"));
  try {
    return db.prepare("SELECT symbol_id FROM symbols ORDER BY symbol_id")
      .all().map((row) => row.symbol_id);
  } finally {
    db.close();
  }
}

test("internal contract selects analyzers and attaches per-fact provenance", async () => {
  assert.equal(ANALYZER_CONTRACT_VERSION, 1);
  assert.equal(analyzerFor("go").id, "go-packages-types");
  assert.equal(analyzerFor("python").id, "text-facts");
  assert.equal(analyzerFor("typescript").capabilities.exactResolution, "static");
  const item = {
    relPath: "client.ts", language: "typescript",
    text: "export function beta() { return request('/api/items'); }"
  };
  const output = await analyzePendingFiles({
    repoRoot: "/unused", pending: [item], trackedSet: new Set(["client.ts"])
  });
  assert.deepEqual(output.diagnostics, []);
  const facts = output.results.get(item.relPath);
  assert.equal(facts.status, "complete");
  assert.equal(facts.symbols[0].provenance.analyzer_id, "typescript-compiler");
  assert.equal(facts.routes[0].provenance.evidence, "text_pattern");
});

test("analyzer version invalidation touches only that language", async () => {
  const root = await fixture();
  try {
    const first = await indexRepository({ repoRoot: root });
    assert.equal(first.changed_files, 2);
    const registry = createAnalyzerRegistry({ goVersion: "3" });
    const second = await indexRepository({ repoRoot: root, analyzerRegistry: registry });
    assert.equal(second.changed_files, 1);
    assert.equal(second.skipped_files, 1);
    const { db } = openStore(path.join(root, ".context-index"));
    try {
      const versions = db.prepare("SELECT path,parser_version FROM files ORDER BY path").all();
      assert.equal(versions.find((row) => row.path === "service.go").parser_version,
        parserVersionFor("go", registry));
      assert.equal(versions.find((row) => row.path === "client.ts").parser_version,
        parserVersionFor("typescript"));
    } finally {
      db.close();
    }
    const warm = await indexRepository({ repoRoot: root, analyzerRegistry: registry });
    assert.equal(warm.changed_files, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Go parse failure preserves old symbols and retries after source repair", async () => {
  const root = await fixture();
  try {
    await indexRepository({ repoRoot: root });
    const before = symbols(root);
    await fs.writeFile(path.join(root, "service.go"), "package fixture\nfunc Alpha( {\n");
    const failed = await indexRepository({ repoRoot: root });
    assert.equal(failed.changed_files, 0);
    assert.equal(failed.analysis_failed_files, 1);
    assert.equal(failed.diagnostics[0].code, "parse_failed");
    assert.deepEqual(symbols(root), before);
    assert.equal(readIndexStatus({ repoRoot: root }).analysis_diagnostics[0].code, "parse_failed");
    const query = queryContext({ repoRoot: root, task: "Alpha" });
    assert.equal(query.coverage.status, "review_required");
    assert.equal(projectQueryOutput(query, { compact: true }).analysis_failed_files, 1);
    await fs.writeFile(path.join(root, "service.go"), "package fixture\nfunc Repaired() {}\n");
    const repaired = await indexRepository({ repoRoot: root });
    assert.equal(repaired.changed_files, 1);
    assert.equal(repaired.analysis_failed_files, 0);
    assert.equal(readIndexStatus({ repoRoot: root }).analysis_diagnostics, undefined);
    assert.ok(symbols(root).includes("go:service.go::Repaired"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("analyzer exception and partial result do not overwrite indexed facts", async () => {
  const root = await fixture();
  try {
    await indexRepository({ repoRoot: root });
    const before = symbols(root);
    await fs.writeFile(path.join(root, "service.go"), "package fixture\nfunc NewGo() {}\n");
    await fs.writeFile(path.join(root, "client.ts"), "export function newTs() { return 2; }\n");
    const registry = createAnalyzerRegistry({
      goAnalyze: () => { throw new Error("tool failed"); },
      scriptAnalyze: () => new Map([["client.ts", {
        status: "partial", symbols: [], dependencies: [],
        diagnostics: [{ message: "not fully parsed" }]
      }]])
    });
    const failed = await indexRepository({ repoRoot: root, analyzerRegistry: registry });
    assert.equal(failed.changed_files, 0);
    assert.equal(failed.analysis_failed_files, 2);
    assert.deepEqual(failed.diagnostics.map((entry) => entry.code).sort(),
      ["analyzer_failed", "incomplete_analysis"]);
    assert.deepEqual(symbols(root), before);
    const recovered = await indexRepository({ repoRoot: root });
    assert.equal(recovered.changed_files, 2);
    assert.ok(symbols(root).includes("go:service.go::NewGo"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("invalid facts cannot claim symbols from another file", async () => {
  const item = { relPath: "client.ts", language: "typescript", text: "" };
  const registry = createAnalyzerRegistry({
    scriptAnalyze: () => new Map([["client.ts", {
      symbols: [{ symbol_id: "wrong", file_path: "other.ts" }],
      dependencies: []
    }]])
  });
  const output = await analyzePendingFiles({
    repoRoot: "/unused", pending: [item], trackedSet: new Set(), registry
  });
  assert.equal(output.results.size, 0);
  assert.equal(output.diagnostics[0].code, "invalid_facts");
});

test("unreadable tracked source reports a diagnostic and retains prior facts", async () => {
  const root = await fixture();
  try {
    await indexRepository({ repoRoot: root });
    const before = symbols(root);
    await fs.writeFile(path.join(root, "client.ts"), Buffer.from([0x61, 0, 0x62]));
    const result = await indexRepository({ repoRoot: root });
    assert.equal(result.unreadable_files, 1);
    assert.equal(result.analysis_failed_files, 1);
    assert.equal(result.diagnostics[0].code, "unreadable_source");
    assert.deepEqual(symbols(root), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
