import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listTrackedSourceFiles } from "../src/git.js";
import { indexRepository } from "../src/context/indexer.js";
import { openStore } from "../src/context/store.js";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], { windowsHide: true });
}

async function write(root, relPath, body) {
  const full = path.join(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
}

test("working-tree indexing includes untracked non-ignored sources and tests safely", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-working-tree-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");

    await write(root, ".gitignore", "ignored/\n*.ignored.js\n");
    await write(root, "src/tracked.js", "export function trackedValue() { return 1; }\n");
    await git(root, "add", ".gitignore", "src/tracked.js");
    await git(root, "commit", "-qm", "baseline");

    await write(root, "src/new-worker.js", "export function newWorkerValue() { return 2; }\n");
    await write(root, "test/new-worker.test.mjs", "export const untrackedTestMarker = 'working-tree-test';\n");
    await write(root, "ignored/hidden.js", "export const hidden = true;\n");
    await write(root, "src/hidden.ignored.js", "export const ignoredByPattern = true;\n");
    await write(root, ".env", "TOKEN=secret\n");
    await write(root, "secret.key", "secret\n");
    await write(root, "package-lock.json", "{\"lockfileVersion\":3}\n");

    const discovered = await listTrackedSourceFiles(root);
    assert.deepEqual(discovered, [
      "src/new-worker.js",
      "src/tracked.js",
      "test/new-worker.test.mjs"
    ]);

    const first = await indexRepository({ repoRoot: root });
    assert.equal(first.changed_files, 3);
    assert.equal(first.removed_files, 0);

    let store = openStore(path.join(root, ".context-index"));
    try {
      const rows = store.db
        .prepare("SELECT path,is_test FROM files ORDER BY path")
        .all()
        .map((row) => ({ path: row.path, is_test: Number(row.is_test) }));
      assert.deepEqual(rows, [
        { path: "src/new-worker.js", is_test: 0 },
        { path: "src/tracked.js", is_test: 0 },
        { path: "test/new-worker.test.mjs", is_test: 1 }
      ]);
    } finally {
      store.db.close();
    }

    const second = await indexRepository({ repoRoot: root });
    assert.equal(second.changed_files, 0);
    assert.equal(second.skipped_files, 3);
    assert.equal(second.removed_files, 0);

    await fs.rm(path.join(root, "test/new-worker.test.mjs"));

    const third = await indexRepository({ repoRoot: root });
    assert.equal(third.changed_files, 0);
    assert.equal(third.removed_files, 1);

    store = openStore(path.join(root, ".context-index"));
    try {
      const paths = store.db
        .prepare("SELECT path FROM files ORDER BY path")
        .all()
        .map((row) => row.path);
      assert.deepEqual(paths, ["src/new-worker.js", "src/tracked.js"]);
    } finally {
      store.db.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
