import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepository } from "../src/context/indexer.js";
import { readIndexStatus } from "../src/context/status.js";
import { openStore } from "../src/context/store.js";
import { packageVersion, runtimeIdentity } from "../src/runtime.js";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], {
    windowsHide: true,
    encoding: "utf8"
  });
}

test("index status detects working-tree and runtime staleness", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-status-"));
  const indexDir = await fs.mkdtemp(path.join(os.tmpdir(), "cce-status-index-"));
  try {
    await git(root, "init");
    await git(root, "config", "user.email", "cce@example.invalid");
    await git(root, "config", "user.name", "CCE Test");

    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "app.js"),
      "export function app() { return 'v1'; }\n"
    );
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2) + "\n"
    );
    await git(root, "add", ".");
    await git(root, "commit", "-m", "fixture");

    const indexed = await indexRepository({ repoRoot: root, indexDir });
    assert.equal(indexed.ok, true);

    const fresh = await readIndexStatus({ repoRoot: root, indexDir });
    assert.equal(fresh.stale, false, JSON.stringify(fresh));
    assert.equal(fresh.runtime.package_version, packageVersion);
    assert.equal(
      fresh.index_provenance.indexed_runtime_fingerprint,
      runtimeIdentity().runtime_fingerprint
    );
    assert.equal(
      fresh.index_provenance.current_repository_head,
      fresh.index_provenance.indexed_repository_head
    );

    await fs.writeFile(
      path.join(root, "src", "app.js"),
      "export function app() { return 'v2'; }\n"
    );
    const changed = await readIndexStatus({ repoRoot: root, indexDir });
    assert.equal(changed.stale, true, JSON.stringify(changed));
    assert.equal(changed.freshness.reasons.changed_files, 1, JSON.stringify(changed));
    assert.deepEqual(changed.freshness.samples.changed_files, ["src/app.js"]);

    await indexRepository({ repoRoot: root, indexDir });
    const refreshed = await readIndexStatus({ repoRoot: root, indexDir });
    assert.equal(refreshed.stale, false, JSON.stringify(refreshed));

    await fs.mkdir(path.join(root, "test"), { recursive: true });
    await fs.writeFile(
      path.join(root, "test", "new.test.mjs"),
      "export const workingTreeProbe = true;\n"
    );
    const added = await readIndexStatus({ repoRoot: root, indexDir });
    assert.equal(added.stale, true, JSON.stringify(added));
    assert.equal(added.freshness.reasons.added_files, 1, JSON.stringify(added));
    assert.deepEqual(added.freshness.samples.added_files, ["test/new.test.mjs"]);

    await indexRepository({ repoRoot: root, indexDir });
    const afterAddedIndex = await readIndexStatus({ repoRoot: root, indexDir });
    assert.equal(afterAddedIndex.stale, false, JSON.stringify(afterAddedIndex));

    await fs.rm(path.join(root, "test", "new.test.mjs"));
    const removed = await readIndexStatus({ repoRoot: root, indexDir });
    assert.equal(removed.stale, true, JSON.stringify(removed));
    assert.equal(removed.freshness.reasons.removed_files, 1, JSON.stringify(removed));
    assert.deepEqual(removed.freshness.samples.removed_files, ["test/new.test.mjs"]);

    await indexRepository({ repoRoot: root, indexDir });
    const afterRemovedIndex = await readIndexStatus({ repoRoot: root, indexDir });
    assert.equal(afterRemovedIndex.stale, false, JSON.stringify(afterRemovedIndex));

    await fs.writeFile(path.join(root, ".gitignore"), "src/ignored.js\n");
    await fs.writeFile(path.join(root, "src", "ignored.js"), "export const ignored = true;\n");
    const ignored = await readIndexStatus({ repoRoot: root, indexDir });
    assert.equal(ignored.stale, false, JSON.stringify(ignored));

    const { db } = openStore(indexDir);
    try {
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)")
        .run("runtime_fingerprint", "old-runtime-fingerprint");
    } finally {
      db.close();
    }

    const runtimeStale = await readIndexStatus({ repoRoot: root, indexDir });
    assert.equal(runtimeStale.stale, true, JSON.stringify(runtimeStale));
    assert.equal(
      runtimeStale.freshness.reasons.runtime_fingerprint_mismatch,
      1,
      JSON.stringify(runtimeStale)
    );

    await indexRepository({ repoRoot: root, indexDir });
    const finalFresh = await readIndexStatus({ repoRoot: root, indexDir });
    assert.equal(finalFresh.stale, false, JSON.stringify(finalFresh));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(indexDir, { recursive: true, force: true });
  }
});
