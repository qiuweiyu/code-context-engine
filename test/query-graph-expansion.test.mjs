import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepository } from "../src/context/indexer.js";
import { queryContext } from "../src/context/retriever.js";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], { windowsHide: true });
}

test("query retrieval expands lexical business anchors through typed graph", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-query-graph-"));
  try {
    await fs.mkdir(path.join(root, "web/src/views"), { recursive: true });
    await fs.mkdir(path.join(root, "web/src/api"), { recursive: true });
    await fs.mkdir(path.join(root, "backend"), { recursive: true });

    await fs.writeFile(
      path.join(root, "web/src/views/AssignmentsView.vue"),
      [
        "<script setup lang=\"ts\">",
        "import { listManualTasks } from '@/api/manual-task'",
        "async function loadAssignments() {",
        "  await listManualTasks()",
        "}",
        "</script>",
        "<template><main>assignments</main></template>",
        ""
      ].join("\n")
    );

    await fs.writeFile(
      path.join(root, "web/src/api/manual-task.ts"),
      [
        "export async function listManualTasks() {",
        "  return request('/api/manual-tasks', { method: 'GET' })",
        "}",
        ""
      ].join("\n")
    );

    await fs.writeFile(
      path.join(root, "backend/api.go"),
      [
        "package backend",
        "import \"net/http\"",
        "type Router struct{}",
        "type API struct{}",
        "func (api *API) List(w http.ResponseWriter, r *http.Request) {}",
        "func register(router *Router, api *API) {",
        "  router.Handle(http.MethodGet, \"/api/manual-tasks\", http.HandlerFunc(api.List))",
        "}",
        ""
      ].join("\n")
    );

    await fs.writeFile(
      path.join(root, ".context-query-aliases.json"),
      JSON.stringify({ "人工任务": ["manual-task", "manualtask"] }, null, 2)
    );

    await git(root, "init", "-q");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "init");

    const indexed = await indexRepository({ repoRoot: root });
    assert.equal(indexed.manifest.schema_version, 8);

    const query = queryContext({
      repoRoot: root,
      task: "人工任务列表为什么没有显示",
      maxFiles: 10
    });

    const selected = [...query.must_read, ...query.maybe_read];
    const page = selected.find((item) => item.path === "web/src/views/AssignmentsView.vue");

    assert.ok(page);
    assert.ok(page.reasons.includes("graph_reverse:page_api"));
    assert.ok(query.must_read.some((item) => item.path === "web/src/api/manual-task.ts"));
    assert.ok(query.graph_expansion.added_files >= 1);
    assert.ok(query.graph_expansion.reverse_steps >= 1);
    assert.ok(
      query.query_expansion.graph_seed_nodes.includes(
        "symbol:typescript:web/src/api/manual-task.ts::listManualTasks"
      )
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
