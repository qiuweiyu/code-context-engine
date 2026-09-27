import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepository } from "../src/context/indexer.js";
import {
  PUBLIC_INDEX_FORMAT,
  PUBLIC_INDEX_VERSION,
  publicV1Directory,
  readPublicIndexV1
} from "../src/public/v1.js";

const exec = promisify(execFile);

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-public-v1-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src/service.ts"),
    [
      "export function helper() { return 1; }",
      "export function run() { return helper(); }",
      ""
    ].join("\n")
  );
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "add", "."]);
  return root;
}

async function publicBytes(root) {
  const dir = publicV1Directory(path.join(root, ".context-index"));
  return {
    nodes: await fs.readFile(path.join(dir, "nodes.jsonl"), "utf8"),
    edges: await fs.readFile(path.join(dir, "edges.jsonl"), "utf8")
  };
}

test("Public Index v1 stays stable across internal force reindex", async () => {
  const root = await makeRepo();
  try {
    const first = await indexRepository({ repoRoot: root });
    assert.equal(first.analysis_failed_files, 0);
    assert.deepEqual(first.manifest.public_index, {
      format: PUBLIC_INDEX_FORMAT,
      version: PUBLIC_INDEX_VERSION,
      path: "public/v1",
      counts: first.manifest.public_index.counts
    });

    const publicIndex = await readPublicIndexV1(
      path.join(root, ".context-index")
    );
    assert.equal(publicIndex.manifest.format, "cce-public-index");
    assert.equal(publicIndex.manifest.version, "1.0.0");
    assert.equal(publicIndex.manifest.internal_schema_version, 9);
    assert.ok(
      publicIndex.nodes.some((node) =>
        node.id === "symbol:typescript:src/service.ts::run"
      )
    );
    const call = publicIndex.edges.find((edge) => edge.type === "call");
    assert.ok(call);
    assert.match(call.id, /^edge:[0-9a-f]{24}$/);
    assert.equal("source_id" in call.evidence, false);

    const before = await publicBytes(root);
    const forced = await indexRepository({ repoRoot: root, force: true });
    assert.ok(forced.changed_files > 0);
    const after = await publicBytes(root);
    assert.deepEqual(after, before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Public Index v1 reader accepts additive unknown fields", async () => {
  const root = await makeRepo();
  try {
    await indexRepository({ repoRoot: root });
    const dir = publicV1Directory(path.join(root, ".context-index"));
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.internal_schema_version = 99;
    manifest.future_optional_field = { enabled: true };
    await fs.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2) + "\n"
    );

    const nodesPath = path.join(dir, "nodes.jsonl");
    const nodeLines = (await fs.readFile(nodesPath, "utf8"))
      .trimEnd().split(/\r?\n/);
    const firstNode = JSON.parse(nodeLines[0]);
    firstNode.future_optional_field = "ignored";
    nodeLines[0] = JSON.stringify(firstNode);
    await fs.writeFile(nodesPath, nodeLines.join("\n") + "\n");

    const loaded = await readPublicIndexV1(path.join(root, ".context-index"));
    assert.equal(loaded.manifest.internal_schema_version, 99);
    assert.equal(loaded.manifest.future_optional_field.enabled, true);
    assert.equal(loaded.nodes[0].future_optional_field, "ignored");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
