import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { indexRepository } from "../src/context/indexer.js";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], { windowsHide: true });
}

async function indexedGoFixture(source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-go-field-call-"));
  await fs.mkdir(path.join(root, "backend/catalog"), { recursive: true });
  await fs.writeFile(path.join(root, "backend/catalog/api.go"), source);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "init");
  const result = await indexRepository({ repoRoot: root });
  const db = new DatabaseSync(path.join(root, ".context-index/index.sqlite"));
  return { root, result, db };
}

function callEdge(db, fromSymbol) {
  return db.prepare(
    "SELECT * FROM edges WHERE type='call' AND from_node_id=? ORDER BY edge_id"
  ).get(`symbol:${fromSymbol}`);
}

test("Go receiver field interface call resolves only with one complete implementation", async () => {
  const source = [
    "package catalog",
    "import \"context\"",
    "type CatalogService interface {",
    "  List(context.Context, int) error",
    "  Get(context.Context, int) error",
    "}",
    "type API struct{ service CatalogService }",
    "func (api *API) Handle(ctx context.Context) error { return api.service.List(ctx, 1) }",
    "type Service struct{}",
    "func (s *Service) List(ctx context.Context, id int) error { return nil }",
    "func (s *Service) Get(ctx context.Context, id int) error { return nil }",
    "type Partial struct{}",
    "func (p *Partial) List(ctx context.Context, id int) error { return nil }",
    ""
  ].join("\n");
  const { root, result, db } = await indexedGoFixture(source);
  try {
    assert.equal(result.manifest.schema_version, 7);
    assert.equal(
      db.prepare("SELECT DISTINCT parser_version AS v FROM files").get().v,
      "0.2.3"
    );
    const edge = callEdge(db, "go:backend/catalog/api.go::*API.Handle");
    assert.ok(edge);
    assert.equal(edge.confidence, "static");
    assert.equal(edge.to_node_id, "symbol:go:backend/catalog/api.go::*Service.List");
    const evidence = JSON.parse(edge.evidence_json);
    assert.equal(evidence.resolution, "receiver_field_interface_unique_implementation");
    assert.equal(evidence.receiver_field, "service");
    assert.equal(evidence.field_type, "CatalogService");
    assert.equal(evidence.resolved_receiver, "Service");
    assert.equal(evidence.candidate_count, 1);
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Go receiver field interface call stays unresolved with multiple implementations", async () => {
  const source = [
    "package catalog",
    "import \"context\"",
    "type CatalogService interface { List(context.Context) error; Get(context.Context) error }",
    "type API struct{ service CatalogService }",
    "func (api *API) Handle(ctx context.Context) error { return api.service.List(ctx) }",
    "type ServiceA struct{}",
    "func (s *ServiceA) List(ctx context.Context) error { return nil }",
    "func (s *ServiceA) Get(ctx context.Context) error { return nil }",
    "type ServiceB struct{}",
    "func (s *ServiceB) List(ctx context.Context) error { return nil }",
    "func (s *ServiceB) Get(ctx context.Context) error { return nil }",
    ""
  ].join("\n");
  const { root, db } = await indexedGoFixture(source);
  try {
    const edge = callEdge(db, "go:backend/catalog/api.go::*API.Handle");
    assert.ok(edge);
    assert.equal(edge.confidence, "unresolved");
    assert.equal(edge.to_node_id, "ref:call:api.service.List");
    const evidence = JSON.parse(edge.evidence_json);
    assert.equal(evidence.resolution, "receiver_field_interface_ambiguous_implementation");
    assert.equal(evidence.candidate_count, 2);
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Go selector call does not resolve from method-name uniqueness alone", async () => {
  const source = [
    "package catalog",
    "import \"context\"",
    "type API struct{}",
    "func (api *API) Handle(ctx context.Context) error { return external.List(ctx) }",
    "type Service struct{}",
    "func (s *Service) List(ctx context.Context) error { return nil }",
    ""
  ].join("\n");
  const { root, db } = await indexedGoFixture(source);
  try {
    const edge = callEdge(db, "go:backend/catalog/api.go::*API.Handle");
    assert.ok(edge);
    assert.equal(edge.confidence, "unresolved");
    assert.equal(edge.to_node_id, "ref:call:external.List");
    assert.equal(JSON.parse(edge.evidence_json).resolution, "selector_receiver_unresolved");
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Go receiver field call stays unresolved when the declared field type has no target", async () => {
  const source = [
    "package catalog",
    "import \"context\"",
    "type API struct{ service MissingService }",
    "func (api *API) Handle(ctx context.Context) error { return api.service.List(ctx) }",
    "type Service struct{}",
    "func (s *Service) List(ctx context.Context) error { return nil }",
    ""
  ].join("\n");
  const { root, db } = await indexedGoFixture(source);
  try {
    const edge = callEdge(db, "go:backend/catalog/api.go::*API.Handle");
    assert.ok(edge);
    assert.equal(edge.confidence, "unresolved");
    assert.equal(edge.to_node_id, "ref:call:api.service.List");
    const evidence = JSON.parse(edge.evidence_json);
    assert.equal(evidence.resolution, "receiver_field_concrete_not_found");
    assert.equal(evidence.field_type, "MissingService");
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
