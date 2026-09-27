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

async function repo(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-vue-sfc-"));
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

test("Vue compiler-sfc analyzes normal script and script setup together", async () => {
  const root = await repo({
    "src/api/users.ts": "export function fetchUsers() { return 1; }\n",
    "src/pages/Users.vue": [
      '<script lang="ts">',
      "export function legacyView() { return 1; }",
      "</script>",
      '<script setup lang="ts">',
      'import { fetchUsers } from "../api/users";',
      "const props = defineProps<{ group: string }>();",
      "const emit = defineEmits<{ save: [] }>();",
      "function loadUsers() { return fetchUsers(); }",
      "</script>",
      "<template><main>{{ props.group }}</main></template>",
      ""
    ].join("\n")
  });
  try {
    assert.equal(analyzerFor("vue").id, "vue-compiler-sfc");
    const result = await indexRepository({ repoRoot: root });
    assert.equal(result.analysis_failed_files, 0);
    withDb(root, (db) => {
      const symbols = db.prepare(
        "SELECT symbol_id,line_start FROM symbols WHERE file_path=? ORDER BY line_start"
      ).all("src/pages/Users.vue");
      assert.deepEqual(symbols.map((row) => row.symbol_id), [
        "vue:src/pages/Users.vue::legacyView",
        "vue:src/pages/Users.vue::loadUsers"
      ]);
      assert.deepEqual(symbols.map((row) => row.line_start), [2, 8]);

      const call = db.prepare(
        "SELECT * FROM dependencies WHERE from_file=? AND relation='calls'"
      ).get("src/pages/Users.vue");
      assert.equal(call.to_ref, "fetchUsers");
      assert.equal(call.resolved_symbol_id, "typescript:src/api/users.ts::fetchUsers");
      assert.equal(JSON.parse(call.metadata_json).resolution, "vue_import_binding_symbol");

      const macroCalls = db.prepare(
        "SELECT to_ref FROM dependencies WHERE from_file=? AND relation='calls' AND to_ref LIKE 'define%'"
      ).all("src/pages/Users.vue");
      assert.deepEqual(macroCalls, []);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Vue component and composable imports preserve static file and call evidence", async () => {
  const root = await repo({
    "src/composables/useUsers.ts": "export function useUsers() { return []; }\n",
    "src/components/UserCard.vue": [
      '<script setup lang="ts">',
      "defineProps<{ name: string }>();",
      "</script>",
      "<template><article /> </template>",
      ""
    ].join("\n"),
    "src/pages/Dashboard.vue": [
      '<script setup lang="ts">',
      'import UserCard from "../components/UserCard.vue";',
      'import { useUsers } from "../composables/useUsers";',
      "defineOptions({ name: 'DashboardPage' });",
      "function loadUsers() { return useUsers(); }",
      "</script>",
      "<template><UserCard /> </template>",
      ""
    ].join("\n")
  });
  try {
    const result = await indexRepository({ repoRoot: root });
    assert.equal(result.analysis_failed_files, 0);
    withDb(root, (db) => {
      const imports = db.prepare(
        "SELECT to_ref,to_file FROM dependencies WHERE from_file=? AND relation='imports' ORDER BY to_ref"
      ).all("src/pages/Dashboard.vue").map((row) => ({
        to_ref: row.to_ref,
        to_file: row.to_file
      }));
      assert.deepEqual(imports, [
        { to_ref: "../components/UserCard.vue", to_file: "src/components/UserCard.vue" },
        { to_ref: "../composables/useUsers", to_file: "src/composables/useUsers.ts" }
      ]);

      const callEdge = db.prepare(
        "SELECT * FROM edges WHERE type='call' AND from_node_id=?"
      ).get("symbol:vue:src/pages/Dashboard.vue::loadUsers");
      assert.equal(
        callEdge.to_node_id,
        "symbol:typescript:src/composables/useUsers.ts::useUsers"
      );
      assert.equal(callEdge.confidence, "static");
      const evidence = JSON.parse(callEdge.evidence_json);
      assert.equal(evidence.resolution, "vue_import_binding_symbol");
      assert.equal(evidence.module_file, "src/composables/useUsers.ts");
      assert.equal(evidence.local_binding, "useUsers");
      assert.equal(evidence.imported_name, "useUsers");
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("new tracked module invalidates Vue importer resolution", async () => {
  const root = await repo({
    "src/pages/Later.vue": [
      '<script setup lang="ts">',
      'import { useLater } from "../composables/useLater";',
      "function loadLater() { return useLater(); }",
      "</script>",
      "<template><main /></template>",
      ""
    ].join("\n")
  });
  try {
    const first = await indexRepository({ repoRoot: root });
    assert.equal(first.analysis_failed_files, 0);
    withDb(root, (db) => {
      const imported = db.prepare(
        "SELECT to_file FROM dependencies WHERE from_file=? AND relation='imports'"
      ).get("src/pages/Later.vue");
      assert.equal(imported.to_file, null);
      const call = db.prepare(
        "SELECT resolved_symbol_id FROM dependencies WHERE from_file=? AND relation='calls'"
      ).get("src/pages/Later.vue");
      assert.equal(call.resolved_symbol_id, null);
    });

    await fs.mkdir(path.join(root, "src/composables"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src/composables/useLater.ts"),
      "export function useLater() { return 1; }\n"
    );
    await exec("git", ["-C", root, "add", "src/composables/useLater.ts"]);

    const second = await indexRepository({ repoRoot: root });
    assert.equal(second.changed_files, 2);
    withDb(root, (db) => {
      const imported = db.prepare(
        "SELECT to_file FROM dependencies WHERE from_file=? AND relation='imports'"
      ).get("src/pages/Later.vue");
      assert.equal(imported.to_file, "src/composables/useLater.ts");
      const call = db.prepare(
        "SELECT resolved_symbol_id FROM dependencies WHERE from_file=? AND relation='calls'"
      ).get("src/pages/Later.vue");
      assert.equal(
        call.resolved_symbol_id,
        "typescript:src/composables/useLater.ts::useLater"
      );
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("malformed Vue SFC preserves prior indexed facts and reports failure", async () => {
  const root = await repo({
    "src/App.vue": [
      '<script setup lang="ts">',
      "function stable() { return 1; }",
      "</script>",
      "<template><main /></template>",
      ""
    ].join("\n")
  });
  try {
    const first = await indexRepository({ repoRoot: root });
    assert.equal(first.analysis_failed_files, 0);
    const before = withDb(root, (db) => db.prepare(
      "SELECT symbol_id FROM symbols WHERE file_path=? ORDER BY symbol_id"
    ).all("src/App.vue").map((row) => row.symbol_id));
    assert.deepEqual(before, ["vue:src/App.vue::stable"]);

    await fs.writeFile(path.join(root, "src/App.vue"), [
      '<script setup lang="ts">',
      "function replacement() { return 2; }",
      "</script>",
      '<script setup lang="ts">',
      "function duplicateSetup() { return 3; }",
      "</script>",
      "<template><main /></template>",
      ""
    ].join("\n"));

    const failed = await indexRepository({ repoRoot: root });
    assert.equal(failed.changed_files, 0);
    assert.equal(failed.analysis_failed_files, 1);
    assert.equal(failed.diagnostics[0].code, "incomplete_analysis");
    const after = withDb(root, (db) => db.prepare(
      "SELECT symbol_id FROM symbols WHERE file_path=? ORDER BY symbol_id"
    ).all("src/App.vue").map((row) => row.symbol_id));
    assert.deepEqual(after, before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
