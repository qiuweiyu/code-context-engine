import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { indexRepository } from "../src/context/indexer.js";
import { traverseGraph } from "../src/context/traversal.js";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], { windowsHide: true });
}

test("test mappings become typed test_of edges with conservative confidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-test-edges-"));
  try {
    await fs.mkdir(path.join(root, "backend/store"), { recursive: true });
    await fs.writeFile(
      path.join(root, "backend/store/service.go"),
      [
        "package store",
        "type Service struct{}",
        "func (s *Service) Load() error { return nil }",
        ""
      ].join("\n")
    );
    await fs.writeFile(
      path.join(root, "backend/store/service_test.go"),
      [
        "package store",
        "import \"testing\"",
        "func TestLoad(t *testing.T) {",
        "  var s Service",
        "  if err := s.Load(); err != nil { t.Fatal(err) }",
        "}",
        ""
      ].join("\n")
    );

    await git(root, "init", "-q");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "init");

    const result = await indexRepository({ repoRoot: root });
    assert.equal(result.manifest.schema_version, 8);

    const db = new DatabaseSync(path.join(root, ".context-index/index.sqlite"));
    try {
      const mappings = db.prepare("SELECT * FROM tests ORDER BY id").all();
      assert.equal(mappings.length, 2);

      const edges = db.prepare(
        "SELECT * FROM edges WHERE type='test_of' ORDER BY source_id"
      ).all();
      assert.equal(edges.length, 2);

      const filename = edges.find(
        (edge) => JSON.parse(edge.evidence_json).resolution === "filename_pair"
      );
      assert.ok(filename);
      assert.equal(filename.from_node_id, "file:backend/store/service_test.go");
      assert.equal(filename.to_node_id, "file:backend/store/service.go");
      assert.equal(filename.confidence, "inferred");

      const directCall = edges.find(
        (edge) => JSON.parse(edge.evidence_json).resolution === "test_calls_symbol"
      );
      assert.ok(directCall);
      assert.equal(directCall.from_node_id, "file:backend/store/service_test.go");
      assert.equal(directCall.to_node_id, "symbol:go:backend/store/service.go::*Service.Load");
      assert.equal(directCall.confidence, "static");

      const evidence = JSON.parse(directCall.evidence_json);
      assert.equal(evidence.source, "tests");
      assert.equal(evidence.mapping_confidence, 0.9);

      const reverse = traverseGraph(db, {
        startNodeIds: "symbol:go:backend/store/service.go::*Service.Load",
        direction: "reverse",
        edgeTypes: ["test_of"],
        maxHops: 1,
        minConfidence: "static"
      });
      assert.equal(reverse.steps.length, 1);
      assert.equal(reverse.steps[0].next_node_id, "file:backend/store/service_test.go");

      const forward = traverseGraph(db, {
        startNodeIds: "file:backend/store/service_test.go",
        edgeTypes: ["test_of"],
        maxHops: 1,
        minConfidence: "inferred"
      });
      assert.equal(forward.steps.length, 2);
    } finally {
      db.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
