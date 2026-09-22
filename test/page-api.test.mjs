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

test("Vue pages link to actually called imported API symbols", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-page-api-"));
  try {
    await fs.mkdir(path.join(root, "web/src/views"), { recursive: true });
    await fs.mkdir(path.join(root, "web/src/components"), { recursive: true });
    await fs.mkdir(path.join(root, "web/src/api"), { recursive: true });

    await fs.writeFile(
      path.join(root, "web/src/api/items.ts"),
      [
        "export async function listItems() { return [] }",
        "export async function getItem() { return null }",
        "export async function unusedApi() { return null }",
        ""
      ].join("\n")
    );
    await fs.writeFile(
      path.join(root, "web/src/api/audit.ts"),
      [
        "export async function listAudit() { return [] }",
        ""
      ].join("\n")
    );
    await fs.writeFile(
      path.join(root, "web/src/views/ItemsView.vue"),
      [
        "<script setup lang=\"ts\">",
        "import { listItems, getItem as fetchItem, unusedApi } from '@/api/items'",
        "import * as auditApi from '@/api/audit'",
        "",
        "async function load() {",
        "  await listItems()",
        "  await fetchItem()",
        "  await auditApi.listAudit()",
        "}",
        "</script>",
        "<template><main>items</main></template>",
        ""
      ].join("\n")
    );
    await fs.writeFile(
      path.join(root, "web/src/components/Widget.vue"),
      [
        "<script setup lang=\"ts\">",
        "import { listItems } from '@/api/items'",
        "async function loadWidget() { await listItems() }",
        "</script>",
        "<template><div>widget</div></template>",
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
      assert.deepEqual(
        db.prepare("SELECT DISTINCT parser_version AS v FROM files ORDER BY v").all().map((row) => row.v),
        ["0.2.5"]
      );

      const importDep = db.prepare(
        "SELECT * FROM dependencies WHERE from_file='web/src/views/ItemsView.vue' AND relation='imports' AND to_ref='@/api/items'"
      ).get();
      assert.ok(importDep);
      assert.equal(importDep.to_file, "web/src/api/items.ts");
      const importMetadata = JSON.parse(importDep.metadata_json);
      assert.deepEqual(
        importMetadata.import_bindings,
        [
          { kind: "named", imported: "listItems", local: "listItems" },
          { kind: "named", imported: "getItem", local: "fetchItem" },
          { kind: "named", imported: "unusedApi", local: "unusedApi" }
        ]
      );

      const edges = db.prepare(
        "SELECT * FROM edges WHERE type='page_api' ORDER BY edge_id"
      ).all();
      assert.equal(edges.length, 3);
      assert.equal(edges.every((edge) => edge.confidence === "static"), true);
      assert.equal(edges.every((edge) => edge.from_node_id === "file:web/src/views/ItemsView.vue"), true);

      assert.deepEqual(
        edges.map((edge) => edge.to_node_id).sort(),
        [
          "symbol:typescript:web/src/api/audit.ts::listAudit",
          "symbol:typescript:web/src/api/items.ts::getItem",
          "symbol:typescript:web/src/api/items.ts::listItems"
        ]
      );

      assert.equal(
        edges.some((edge) => edge.to_node_id.endsWith("::unusedApi")),
        false
      );
      assert.equal(
        edges.some((edge) => edge.from_node_id === "file:web/src/components/Widget.vue"),
        false
      );

      const aliasEdge = edges.find((edge) => edge.to_node_id.endsWith("::getItem"));
      const aliasEvidence = JSON.parse(aliasEdge.evidence_json);
      assert.equal(aliasEvidence.local_binding, "fetchItem");
      assert.equal(aliasEvidence.imported_name, "getItem");
      assert.equal(aliasEvidence.resolution, "import_binding_symbol");

      const namespaceEdge = edges.find((edge) => edge.to_node_id.endsWith("::listAudit"));
      const namespaceEvidence = JSON.parse(namespaceEdge.evidence_json);
      assert.equal(namespaceEvidence.binding_kind, "namespace");
      assert.equal(namespaceEvidence.local_binding, "auditApi");
      assert.equal(namespaceEvidence.imported_name, "listAudit");
    } finally {
      db.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
