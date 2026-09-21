import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepository } from "../src/context/indexer.js";
import { queryContext } from "../src/context/retriever.js";
import { readIndexStatus } from "../src/context/status.js";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], { windowsHide: true });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-test-"));
  await fs.mkdir(path.join(root, "backend/task"), { recursive: true });
  await fs.mkdir(path.join(root, "admin/src"), { recursive: true });
  await fs.mkdir(path.join(root, ".context-features"), { recursive: true });
  await fs.writeFile(path.join(root, "backend/task/service.go"), `package task\n\nimport "context"\n\n// UpdateManualTask updates an unpublished manual task.\nfunc (s *Service) UpdateManualTask(ctx context.Context, taskID int64, input UpdateInput) error {\n    if err := s.repo.Update(ctx, taskID, input); err != nil { return err }\n    return nil\n}\n\ntype Service struct{ repo *Repository }\ntype Repository struct{}\ntype UpdateInput struct{ Name string }\nfunc (r *Repository) Update(ctx context.Context, taskID int64, input UpdateInput) error { return nil }\n`);
  await fs.writeFile(path.join(root, "backend/task/service_test.go"), `package task\nimport "testing"\nfunc TestUpdateManualTask(t *testing.T) { var s Service; _ = s }\n`);
  await fs.writeFile(path.join(root, "admin/src/manualTask.ts"), `/** Update an unpublished manual task from the admin UI. */\nexport async function updateManualTask(id: number, input: UpdateInput): Promise<void> {\n  await request(\`/admin/manual-tasks/\${id}\`, { method: 'PUT', body: input })\n}\n\nexport interface UpdateInput { name: string }\n`);
  const feature = {
    id: "manual-task-edit",
    name: "未发布人工任务编辑",
    description: "管理员编辑尚未发布的人工任务。",
    steps: [
      { order: 1, action: "管理端提交编辑请求", symbol_id: "typescript:admin/src/manualTask.ts::updateManualTask" },
      { order: 2, action: "后端更新人工任务", symbol_id: "go:backend/task::*Service.UpdateManualTask" }
    ],
    invariants: ["已发布任务禁止编辑"]
  };
  await fs.writeFile(path.join(root, ".context-features/manual-task.json"), JSON.stringify(feature, null, 2));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "init");
  return root;
}

async function readSingleJsonl(file) {
  const lines = (await fs.readFile(file, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}

test("context index is incremental and feature freshness follows code changes", async () => {
  const root = await fixture();
  try {
    const first = await indexRepository({ repoRoot: root });
    assert.equal(first.changed_files, 3);
    assert.equal(first.manifest.counts.symbols, 4);
    assert.equal(first.manifest.feature_status.valid, 1);

    const query = queryContext({ repoRoot: root, task: "未发布人工任务增加编辑功能", maxFiles: 10 });
    assert.equal(query.features[0].id, "manual-task-edit");
    assert.equal(query.coverage.status, "sufficient");
    assert.ok(query.must_read.some((x) => x.path === "backend/task/service.go"));
    assert.ok(query.must_read.some((x) => x.path === "admin/src/manualTask.ts"));
    assert.ok(query.tests.includes("backend/task/service_test.go"));
    assert.equal(query.semantic_refinement_recommended, false);

    const second = await indexRepository({ repoRoot: root });
    assert.equal(second.changed_files, 0);
    assert.equal(second.skipped_files, 3);

    const featureBefore = await readSingleJsonl(path.join(root, ".context-index/features.jsonl"));
    const goPath = path.join(root, "backend/task/service.go");
    let go = await fs.readFile(goPath, "utf8");
    go = go.replace("// UpdateManualTask updates an unpublished manual task.", "// UpdateManualTask validates and updates an unpublished manual task.")
      .replace("func (s *Service) UpdateManualTask(ctx context.Context, taskID int64, input UpdateInput) error {", "func (s *Service) UpdateManualTask(ctx context.Context, taskID int64, input UpdateInput, actorID int64) error {\n    if actorID <= 0 { return nil }");
    await fs.writeFile(goPath, go);

    const changed = await indexRepository({ repoRoot: root });
    assert.equal(changed.changed_files, 1);
    assert.equal(changed.manifest.feature_status.needs_review, 1);
    const featureAfter = await readSingleJsonl(path.join(root, ".context-index/features.jsonl"));
    assert.notEqual(featureAfter.generated_hash, featureBefore.generated_hash);
    assert.equal(featureAfter.status, "needs_review");
    assert.match(featureAfter.steps[1].signature, /actorID int64/);
    assert.match(featureAfter.steps[1].symbol_description, /validates and updates/);
    const reviewQuery = queryContext({ repoRoot: root, task: "未发布人工任务增加编辑功能" });
    assert.equal(reviewQuery.coverage.status, "review_required");

    go = (await fs.readFile(goPath, "utf8"))
      .replaceAll("UpdateManualTask", "EditManualTask");
    await fs.writeFile(goPath, go);
    const renamed = await indexRepository({ repoRoot: root });
    assert.equal(renamed.manifest.feature_status.stale, 1);
    const status = readIndexStatus({ repoRoot: root });
    assert.equal(status.features[0].status, "stale");
    assert.equal(status.features[0].stale_reason, "unresolved_feature_symbol");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
