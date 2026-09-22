import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { indexRepository } from "../src/context/indexer.js";
import { rebuildDbObjectEdges } from "../src/context/edges.js";
import { traverseGraph } from "../src/context/traversal.js";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], { windowsHide: true });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-db-edges-"));
  await fs.mkdir(path.join(root, "backend/store"), { recursive: true });
  await fs.mkdir(path.join(root, "migrations"), { recursive: true });

  await fs.writeFile(
    path.join(root, "backend/store/repository.go"),
    [
      "package store",
      "",
      "type Repo struct{}",
      "",
      "func (r *Repo) Load() {",
      "  query := \"SELECT a.id FROM accounts a JOIN profiles p ON p.account_id = a.id\"",
      "  _ = query",
      "}",
      "",
      "func (r *Repo) Save() {",
      "  insertQuery := \"INSERT INTO accounts(id) VALUES (1)\"",
      "  updateQuery := \"UPDATE accounts SET name='x' WHERE id=1\"",
      "  deleteQuery := \"DELETE FROM profiles WHERE account_id=1\"",
      "  _, _, _ = insertQuery, updateQuery, deleteQuery",
      "}",
      ""
    ].join("\n")
  );

  await fs.writeFile(
    path.join(root, "migrations/001_audit.sql"),
    [
      "CREATE TABLE audit_log(id bigint);",
      "ALTER TABLE audit_log ADD COLUMN note text;",
      ""
    ].join("\n")
  );

  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "init");
  return root;
}

test("database source facts become conservative typed graph edges", async () => {
  const root = await fixture();
  try {
    const result = await indexRepository({ repoRoot: root });
    assert.equal(result.manifest.schema_version, 8);

    const db = new DatabaseSync(path.join(root, ".context-index/index.sqlite"));
    try {
      assert.deepEqual(
        db.prepare("SELECT DISTINCT parser_version AS v FROM files ORDER BY v").all().map((row) => row.v),
        ["0.2.5"]
      );

      const dbObjects = db.prepare(
        "SELECT * FROM db_objects ORDER BY id"
      ).all();
      assert.equal(dbObjects.length, 7);

      const edges = db.prepare(
        "SELECT * FROM edges WHERE source_kind='db_object' ORDER BY source_id"
      ).all();
      assert.equal(edges.length, 7);
      assert.equal(edges.every((edge) => edge.confidence === "static"), true);

      const loadNode = "symbol:go:backend/store/repository.go::*Repo.Load";
      const loadEdges = edges.filter((edge) => edge.from_node_id === loadNode);
      assert.deepEqual(
        loadEdges.map((edge) => [edge.type, edge.to_node_id]).sort(),
        [
          ["db_read", "db:table:accounts"],
          ["db_read", "db:table:profiles"]
        ]
      );

      const saveNode = "symbol:go:backend/store/repository.go::*Repo.Save";
      const saveEdges = edges.filter((edge) => edge.from_node_id === saveNode);
      assert.deepEqual(
        saveEdges.map((edge) => [edge.type, edge.to_node_id]).sort(),
        [
          ["db_write", "db:table:accounts"],
          ["db_write", "db:table:accounts"],
          ["db_write", "db:table:profiles"]
        ]
      );

      const migrationEdges = edges.filter(
        (edge) => edge.from_node_id === "file:migrations/001_audit.sql"
      );
      assert.equal(migrationEdges.length, 2);
      assert.equal(migrationEdges.every((edge) => edge.type === "db_write"), true);
      assert.equal(migrationEdges.every((edge) => edge.to_node_id === "db:table:audit_log"), true);

      for (const edge of edges) {
        const evidence = JSON.parse(edge.evidence_json);
        assert.equal(evidence.source, "db_objects");
        assert.equal(evidence.resolution, "sql_object_operation");
        assert.equal(evidence.object_type, "table");
        assert.ok(["select", "join", "insert", "update", "delete", "create", "alter"].includes(evidence.operation));
      }

      const traversal = traverseGraph(db, {
        startNodeIds: loadNode,
        edgeTypes: ["db_read"],
        maxHops: 1,
        branchLimit: 8
      });
      assert.equal(traversal.steps.length, 2);
      const databaseNodes = traversal.visited_nodes.filter((node) => node.kind === "db_object");
      assert.deepEqual(
        databaseNodes.map((node) => [node.object_type, node.object_name]).sort(),
        [["table", "accounts"], ["table", "profiles"]]
      );

      const unsupported = db.prepare(
        "INSERT INTO db_objects(file_path,symbol_id,object_type,object_name,operation,line) VALUES(?,?,?,?,?,?)"
      ).run(
        "backend/store/repository.go",
        "go:backend/store/repository.go::*Repo.Save",
        "table",
        "sessions",
        "truncate",
        12
      );
      rebuildDbObjectEdges(db);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM edges WHERE source_kind='db_object'").get().n,
        7
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM edges WHERE source_kind='db_object' AND source_id=?").get(Number(unsupported.lastInsertRowid)).n,
        0
      );
    } finally {
      db.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
