import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepository } from "../src/context/indexer.js";
import { openStore } from "../src/context/store.js";
import { analyzerFor } from "../src/context/analyzers.js";

const exec = promisify(execFile);

async function write(root, name, body) {
  const full = path.join(root, name);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
}

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-go-types-"));
  await write(root, "go.mod", [
    "module example.com/ccefixture",
    "",
    "go 1.25.0",
    ""
  ].join("\n"));
  await write(root, "store/store.go", [
    "package store",
    "",
    "func Fetch(id int) int { return id }",
    "",
    "type Box[T any] struct { Value T }",
    "func NewBox[T any](value T) Box[T] { return Box[T]{Value: value} }",
    "func (b Box[T]) Get() T { return b.Value }",
    "",
    "type Reader interface { Read() string }",
    "type FileReader struct{}",
    "func (FileReader) Read() string { return \"file\" }",
    ""
  ].join("\n"));
  await write(root, "service/service.go", [
    "package service",
    "",
    'import "example.com/ccefixture/store"',
    "",
    "func Load() int { return store.Fetch(7) }",
    "",
    "func Generic() int {",
    "  box := store.NewBox[int](3)",
    "  return box.Get()",
    "}",
    "",
    "func ViaInterface(reader store.Reader) string {",
    "  return reader.Read()",
    "}",
    ""
  ].join("\n"));
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

test("go/packages + go/types resolves cross-package functions and generic methods conservatively", async () => {
  const root = await makeRepo();
  try {
    assert.equal(analyzerFor("go").id, "go-packages-types");
    const result = await indexRepository({ repoRoot: root });
    assert.equal(result.analysis_failed_files, 0);

    withDb(root, (db) => {
      const rows = db.prepare(
        `SELECT from_symbol_id,to_ref,resolved_symbol_id,metadata_json
           FROM dependencies
          WHERE from_file='service/service.go' AND relation='calls'
          ORDER BY from_symbol_id,to_ref`
      ).all().map((row) => ({
        from_symbol_id: row.from_symbol_id,
        to_ref: row.to_ref,
        resolved_symbol_id: row.resolved_symbol_id,
        metadata: JSON.parse(row.metadata_json)
      }));

      const fetch = rows.find((row) => row.to_ref === "store.Fetch");
      assert.ok(fetch);
      assert.equal(fetch.resolved_symbol_id, "go:store/store.go::Fetch");
      assert.equal(fetch.metadata.go_types_checked, true);
      assert.equal(fetch.metadata.resolution, "go_types_object");
      assert.equal(fetch.metadata.target_package, "example.com/ccefixture/store");

      const newBox = rows.find((row) => row.to_ref === "store.NewBox");
      assert.ok(newBox);
      assert.equal(newBox.resolved_symbol_id, "go:store/store.go::NewBox");
      assert.equal(newBox.metadata.resolution, "go_types_object");

      const get = rows.find((row) => row.to_ref === "box.Get");
      assert.ok(get);
      assert.equal(get.resolved_symbol_id, "go:store/store.go::Box[T].Get");
      assert.equal(get.metadata.resolution, "go_types_object");

      const iface = rows.find((row) => row.to_ref === "reader.Read");
      assert.ok(iface);
      assert.equal(iface.resolved_symbol_id, null);
      assert.equal(iface.metadata.go_types_checked, true);
      assert.equal(iface.metadata.resolution, "go_types_interface_dispatch_unresolved");

      const edge = db.prepare(
        `SELECT confidence,evidence_json
           FROM edges
          WHERE type='call'
            AND from_node_id='symbol:go:service/service.go::Generic'
            AND to_node_id='symbol:go:store/store.go::Box[T].Get'`
      ).get();
      assert.ok(edge);
      assert.equal(edge.confidence, "static");
      const evidence = JSON.parse(edge.evidence_json);
      assert.equal(evidence.go_types_checked, true);
      assert.equal(evidence.target_package, "example.com/ccefixture/store");
      assert.equal(evidence.resolution, "go_types_object");
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("Go package changes reanalyze module Go files and clear stale typed edges", async () => {
  const root = await makeRepo();
  try {
    const first = await indexRepository({ repoRoot: root });
    assert.equal(first.analysis_failed_files, 0);

    const storePath = path.join(root, "store/store.go");
    const original = await fs.readFile(storePath, "utf8");
    await fs.writeFile(
      storePath,
      original.replace(
        "func Fetch(id int) int { return id }",
        "func Fetch2(id int) int { return id }"
      )
    );
    await exec("git", ["-C", root, "add", "store/store.go"]);

    const broken = await indexRepository({ repoRoot: root });
    assert.equal(broken.changed_files, 2);
    withDb(root, (db) => {
      const call = db.prepare(
        `SELECT resolved_symbol_id,metadata_json
           FROM dependencies
          WHERE from_file='service/service.go'
            AND relation='calls'
            AND to_ref='store.Fetch'`
      ).get();
      assert.ok(call);
      assert.equal(call.resolved_symbol_id, null);
      assert.notEqual(JSON.parse(call.metadata_json).resolution, "go_types_object");
    });

    await fs.writeFile(storePath, original);
    await exec("git", ["-C", root, "add", "store/store.go"]);
    const repaired = await indexRepository({ repoRoot: root });
    assert.equal(repaired.changed_files, 2);
    withDb(root, (db) => {
      const call = db.prepare(
        `SELECT resolved_symbol_id,metadata_json
           FROM dependencies
          WHERE from_file='service/service.go'
            AND relation='calls'
            AND to_ref='store.Fetch'`
      ).get();
      assert.equal(call.resolved_symbol_id, "go:store/store.go::Fetch");
      assert.equal(JSON.parse(call.metadata_json).resolution, "go_types_object");
    });

    const warm = await indexRepository({ repoRoot: root });
    assert.equal(warm.changed_files, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("go/packages load errors keep AST facts and expose diagnostics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-go-types-missing-"));
  try {
    await write(root, "go.mod", [
      "module example.com/broken",
      "",
      "go 1.25.0",
      ""
    ].join("\n"));
    await write(root, "main.go", [
      "package broken",
      "",
      'import missing "example.invalid/not-present"',
      "",
      "func Run() { missing.Do() }",
      ""
    ].join("\n"));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "add", "."]);

    const result = await indexRepository({ repoRoot: root });
    assert.equal(result.analysis_failed_files, 0);
    assert.equal(
      result.diagnostics.some((entry) => entry.code === "go_packages_error"),
      true
    );

    withDb(root, (db) => {
      const symbol = db.prepare(
        "SELECT symbol_id FROM symbols WHERE file_path='main.go' AND name='Run'"
      ).get();
      assert.equal(symbol.symbol_id, "go:main.go::Run");

      const call = db.prepare(
        `SELECT resolved_symbol_id,metadata_json
           FROM dependencies
          WHERE from_file='main.go'
            AND relation='calls'
            AND to_ref='missing.Do'`
      ).get();
      assert.ok(call);
      assert.equal(call.resolved_symbol_id, null);
      assert.notEqual(JSON.parse(call.metadata_json).resolution, "go_types_object");
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("go.mod changes invalidate typed Go package facts", async () => {
  const root = await makeRepo();
  try {
    const first = await indexRepository({ repoRoot: root });
    assert.equal(first.analysis_failed_files, 0);

    const modPath = path.join(root, "go.mod");
    await fs.writeFile(modPath, [
      "module example.com/ccefixture",
      "",
      "go 1.25.1",
      ""
    ].join("\n"));
    await exec("git", ["-C", root, "add", "go.mod"]);

    const changed = await indexRepository({ repoRoot: root });
    assert.equal(changed.changed_files, 3);
    withDb(root, (db) => {
      const call = db.prepare(
        `SELECT resolved_symbol_id
           FROM dependencies
          WHERE from_file='service/service.go'
            AND relation='calls'
            AND to_ref='store.Fetch'`
      ).get();
      assert.equal(call.resolved_symbol_id, "go:store/store.go::Fetch");
    });

    const warm = await indexRepository({ repoRoot: root });
    assert.equal(warm.changed_files, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
