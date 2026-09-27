import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepository } from "../src/context/indexer.js";
import { openStore } from "../src/context/store.js";

const exec = promisify(execFile);

async function makeRepo(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-ts-resolution-"));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "add", "."]);
  return root;
}

function withDb(root, fn) {
  const { db } = openStore(path.join(root, ".context-index"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function callEdge(db, fromName) {
  return db.prepare(
    "SELECT * FROM edges WHERE type='call' AND from_node_id LIKE ? ORDER BY edge_id"
  ).all("%::" + fromName);
}

test("TypeScript paths alias resolves tracked import and call target", async () => {
  const root = await makeRepo({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@api/*": ["src/api/*"] },
        module: "ESNext",
        moduleResolution: "Bundler"
      }
    }),
    "src/api/users.ts": "export function fetchUsers() { return 1; }\n",
    "src/feature/load.ts": [
      'import { fetchUsers } from "@api/users";',
      "export function loadUsers() { return fetchUsers(); }",
      ""
    ].join("\n")
  });
  try {
    const result = await indexRepository({ repoRoot: root });
    assert.equal(result.analysis_failed_files, 0);
    withDb(root, (db) => {
      const imported = db.prepare(
        "SELECT * FROM dependencies WHERE from_file=? AND relation='imports'"
      ).get("src/feature/load.ts");
      assert.equal(imported.to_file, "src/api/users.ts");
      assert.equal(JSON.parse(imported.metadata_json).resolution, "ts_module_resolution");
      const calls = callEdge(db, "loadUsers");
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].to_node_id,
        "symbol:typescript:src/api/users.ts::fetchUsers"
      );
      assert.equal(calls[0].confidence, "static");
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("JavaScript alias and renamed import resolve through jsconfig", async () => {
  const root = await makeRepo({
    "jsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "#lib/*": ["src/lib/*"] },
        module: "ESNext",
        moduleResolution: "Bundler"
      }
    }),
    "src/lib/api.js": "export function listItems() { return 1; }\n",
    "src/app.js": [
      'import { listItems as load } from "#lib/api";',
      "export function run() { return load(); }",
      ""
    ].join("\n")
  });
  try {
    const result = await indexRepository({ repoRoot: root });
    assert.equal(result.analysis_failed_files, 0);
    withDb(root, (db) => {
      const calls = callEdge(db, "run");
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].to_node_id,
        "symbol:javascript:src/lib/api.js::listItems"
      );
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("conflicting star re-exports stay unresolved instead of guessing", async () => {
  const root = await makeRepo({
    "src/a.ts": "export function shared() { return 'a'; }\n",
    "src/b.ts": "export function shared() { return 'b'; }\n",
    "src/index.ts": [
      'export * from "./a";',
      'export * from "./b";',
      ""
    ].join("\n"),
    "src/use.ts": [
      'import { shared } from "./index";',
      "export function run() { return shared(); }",
      ""
    ].join("\n")
  });
  try {
    await indexRepository({ repoRoot: root });
    withDb(root, (db) => {
      const dep = db.prepare(
        "SELECT * FROM dependencies WHERE from_file=? AND relation='calls'"
      ).get("src/use.ts");
      assert.equal(dep.resolved_symbol_id, null);
      assert.equal(JSON.parse(dep.metadata_json).resolution, "ts_call_unresolved");
      const calls = callEdge(db, "run");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].confidence, "unresolved");
      assert.match(calls[0].to_node_id, /^ref:call:/);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("nearest tsconfig isolates identical aliases across project groups", async () => {
  const config = JSON.stringify({
    compilerOptions: {
      baseUrl: ".",
      paths: { "@api": ["src/api"] },
      module: "ESNext",
      moduleResolution: "Bundler"
    }
  });
  const root = await makeRepo({
    "packages/a/tsconfig.json": config,
    "packages/a/src/api.ts": "export function target() { return 'a'; }\n",
    "packages/a/src/use.ts": [
      'import { target } from "@api";',
      "export function runA() { return target(); }",
      ""
    ].join("\n"),
    "packages/b/tsconfig.json": config,
    "packages/b/src/api.ts": "export function target() { return 'b'; }\n",
    "packages/b/src/use.ts": [
      'import { target } from "@api";',
      "export function runB() { return target(); }",
      ""
    ].join("\n")
  });
  try {
    const result = await indexRepository({ repoRoot: root });
    assert.equal(result.analysis_failed_files, 0);
    withDb(root, (db) => {
      assert.equal(
        callEdge(db, "runA")[0].to_node_id,
        "symbol:typescript:packages/a/src/api.ts::target"
      );
      assert.equal(
        callEdge(db, "runB")[0].to_node_id,
        "symbol:typescript:packages/b/src/api.ts::target"
      );
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("dynamic import remains unresolved and reports a diagnostic", async () => {
  const root = await makeRepo({
    "src/target.ts": "export function go() { return 1; }\n",
    "src/loader.ts": [
      "export async function load() {",
      '  const mod = await import("./target");',
      "  return mod.go();",
      "}",
      ""
    ].join("\n")
  });
  try {
    const result = await indexRepository({ repoRoot: root });
    assert.equal(result.analysis_failed_files, 0);
    assert.equal(
      result.diagnostics.some((entry) => entry.code === "dynamic_import_unresolved"),
      true
    );
    withDb(root, (db) => {
      const dep = db.prepare(
        "SELECT * FROM dependencies WHERE from_file=? AND relation='imports'"
      ).get("src/loader.ts");
      assert.equal(dep.to_file, null);
      assert.equal(JSON.parse(dep.metadata_json).resolution, "dynamic_import_unresolved");
      const calls = callEdge(db, "load");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].confidence, "unresolved");
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("missing dependency stays unresolved and exposes compiler diagnostic", async () => {
  const root = await makeRepo({
    "src/use.ts": [
      'import { missingCall } from "missing-package";',
      "export function runMissing() { return missingCall(); }",
      ""
    ].join("\n")
  });
  try {
    const result = await indexRepository({ repoRoot: root });
    assert.equal(result.analysis_failed_files, 0);
    assert.equal(
      result.diagnostics.some((entry) => entry.code === "ts_2307"),
      true
    );
    withDb(root, (db) => {
      const imported = db.prepare(
        "SELECT * FROM dependencies WHERE from_file=? AND relation='imports'"
      ).get("src/use.ts");
      assert.equal(imported.to_file, null);
      assert.equal(JSON.parse(imported.metadata_json).resolution, "module_unresolved");
      const calls = callEdge(db, "runMissing");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].confidence, "unresolved");
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("tsconfig path change invalidates compiler files and moves the call edge", async () => {
  const root = await makeRepo({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@api": ["src/a"] },
        module: "ESNext",
        moduleResolution: "Bundler"
      }
    }),
    "src/a.ts": "export function target() { return 'a'; }\n",
    "src/b.ts": "export function target() { return 'b'; }\n",
    "src/use.ts": [
      'import { target } from "@api";',
      "export function run() { return target(); }",
      ""
    ].join("\n")
  });
  try {
    const first = await indexRepository({ repoRoot: root });
    assert.equal(first.changed_files, 4);
    withDb(root, (db) => {
      assert.equal(
        callEdge(db, "run")[0].to_node_id,
        "symbol:typescript:src/a.ts::target"
      );
    });

    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@api": ["src/b"] },
          module: "ESNext",
          moduleResolution: "Bundler"
        }
      })
    );
    const changed = await indexRepository({ repoRoot: root });
    assert.equal(changed.changed_files, 4);
    withDb(root, (db) => {
      assert.equal(
        callEdge(db, "run")[0].to_node_id,
        "symbol:typescript:src/b.ts::target"
      );
    });

    const warm = await indexRepository({ repoRoot: root });
    assert.equal(warm.changed_files, 0);
    assert.equal(warm.skipped_files, 4);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
