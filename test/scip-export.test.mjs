import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepository } from "../src/context/indexer.js";
import { exportScipIndex, inspectScipIndex } from "../src/public/scip.js";

const exec = promisify(execFile);

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-scip-v1-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src/service.ts"),
    [
      "export function run() { return 1; }",
      "export function helper() { return helper; }",
      ""
    ].join("\n")
  );
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "add", "."]);
  return root;
}

test("SCIP export round-trip emits symbol information and only proven definition ranges", async () => {
  const root = await makeRepo();
  try {
    await indexRepository({ repoRoot: root });
    const indexDir = path.join(root, ".context-index");
    const out = path.join(root, "index.scip");

    const result = await exportScipIndex({
      repoRoot: root,
      indexDir,
      outFile: out,
      repository: "fixture"
    });
    assert.equal(result.ok, true);
    assert.equal(result.documents, 1);
    assert.equal(result.symbols, 2);
    assert.equal(result.definitions, 1);

    const summary = await inspectScipIndex(out);
    assert.equal(summary.tool_name, "code-context-engine");
    assert.equal(summary.tool_version, "0.1.7");
    assert.match(summary.project_root, /^file:/);
    assert.equal(summary.documents.length, 1);
    assert.equal(summary.documents[0].relative_path, "src/service.ts");
    assert.equal(summary.documents[0].language, "TypeScript");
    assert.equal(summary.documents[0].symbols, 2);
    assert.equal(summary.documents[0].occurrences, 1);
    assert.equal(summary.documents[0].definitions.length, 1);
    assert.match(summary.documents[0].definitions[0], /run/);
    assert.equal(summary.documents[0].definitions.some((x) => /helper/.test(x)), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("export-scip CLI is explicit and writes a readable SCIP file", async () => {
  const root = await makeRepo();
  try {
    await indexRepository({ repoRoot: root });
    const out = path.join(root, "cli-index.scip");
    const { stdout } = await exec(process.execPath, [
      "src/cli.js",
      "export-scip",
      "--repo", root,
      "--out", out,
      "--repository", "cli-fixture"
    ], {
      cwd: new URL("..", import.meta.url),
      timeout: 120000,
      maxBuffer: 1024 * 1024
    });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(path.resolve(result.path), path.resolve(out));
    const summary = await inspectScipIndex(out);
    assert.equal(summary.documents[0].symbols, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
