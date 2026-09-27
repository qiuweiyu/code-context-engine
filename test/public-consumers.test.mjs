import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepository } from "../src/context/indexer.js";
import { readPublicIndexV1 } from "../src/public/v1.js";
import {
  locateNodeInPublicIndex,
  locatePublicNode
} from "../src/public/locate.js";
import {
  buildGraphViewModel,
  exportGraphHtml
} from "../src/public/graph-html.js";

const exec = promisify(execFile);

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-public-consumer-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src/app.ts"),
    [
      "function Handle() {",
      '  const query = "SELECT * FROM tasks";',
      "  return query;",
      "}",
      "function RunJob() { return Handle(); }",
      'app.GET("/tasks", Handle);',
      'cron.schedule("@daily", RunJob);',
      ""
    ].join("\n")
  );
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "add", "."]);
  await indexRepository({ repoRoot: root });
  return root;
}

function publicDir(root) {
  return path.join(root, ".context-index");
}

test("Public Index v1 locate resolves supported source-bearing node kinds", async () => {
  const root = await makeRepo();
  try {
    const indexDir = publicDir(root);
    const publicIndex = await readPublicIndexV1(indexDir);
    const doc = publicIndex.nodes.find((node) =>
      node.kind === "document" && node.path === "src/app.ts"
    );
    const symbol = publicIndex.nodes.find((node) =>
      node.kind === "symbol" && node.name === "Handle"
    );
    const entry = publicIndex.nodes.find((node) =>
      node.kind === "entry" && node.entry_name === "@daily"
    );
    const route = publicIndex.nodes.find((node) =>
      node.kind === "route" && node.route_path === "/tasks"
    );
    const data = publicIndex.nodes.find((node) =>
      node.kind === "data_object" && node.object_name === "tasks"
    );
    const reference = { id: "ref:call:externalMissing", kind: "reference" };
    const withReference = {
      ...publicIndex,
      nodes: [...publicIndex.nodes, reference]
    };

    assert.ok(doc);
    assert.ok(symbol);
    assert.ok(entry);
    assert.ok(route);
    assert.ok(data);

    const cases = [
      [doc.id, "document", 1],
      [symbol.id, "symbol", 1],
      [entry.id, "entry", 7],
      [route.id, "route", 6],
      [data.id, "data_object", 2]
    ];
    for (const [nodeId, kind, line] of cases) {
      const result = locateNodeInPublicIndex(publicIndex, {
        repoRoot: root,
        nodeId,
        editor: "vscode"
      });
      assert.equal(result.found, true);
      assert.equal(result.node_kind, kind);
      assert.ok(result.locations.length >= 1);
      assert.equal(result.locations[0].document, "src/app.ts");
      assert.equal(result.locations[0].line, line);
      assert.match(result.locations[0].file_uri, /^file:/);
      assert.match(result.locations[0].vscode_uri, /^vscode:\/\/file/);
      assert.equal(result.locations[0].open_uri, result.locations[0].vscode_uri);
    }

    const refResult = locateNodeInPublicIndex(withReference, {
      repoRoot: root,
      nodeId: reference.id,
      editor: "file"
    });
    assert.equal(refResult.found, true);
    assert.deepEqual(refResult.locations, []);

    const missing = await locatePublicNode({
      repoRoot: root,
      indexDir,
      nodeId: "symbol:missing",
      editor: "file"
    });
    assert.equal(missing.found, false);
    assert.deepEqual(missing.locations, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("graph model is deterministic, bounded and follows Public Index v1 neighborhood", async () => {
  const root = await makeRepo();
  try {
    const indexDir = publicDir(root);
    const publicIndex = await readPublicIndexV1(indexDir);
    const entry = publicIndex.nodes.find((node) =>
      node.kind === "entry" && node.entry_name === "@daily"
    );
    assert.ok(entry);

    const options = {
      repoRoot: root,
      indexDir,
      focusNodeId: entry.id,
      maxNodes: 12,
      maxHops: 3
    };
    const first = await buildGraphViewModel(options);
    const second = await buildGraphViewModel(options);
    assert.deepEqual(second, first);
    assert.equal(first.format, "cce-graph-view");
    assert.equal(first.public_index.format, "cce-public-index");
    assert.equal(first.focus_node_id, entry.id);
    assert.ok(first.nodes.some((node) => node.id === entry.id));
    assert.ok(first.nodes.some((node) =>
      node.kind === "symbol" && node.name === "RunJob"
    ));
    assert.ok(first.nodes.some((node) =>
      node.kind === "symbol" && node.name === "Handle"
    ));
    assert.ok(first.nodes.some((node) =>
      node.kind === "data_object" && node.object_name === "tasks"
    ));
    assert.ok(first.edges.some((edge) => edge.type === "entry_handler"));
    assert.ok(first.edges.some((edge) => edge.type === "call"));
    assert.ok(first.edges.some((edge) => edge.type === "db_read"));

    const small = await buildGraphViewModel({
      ...options,
      maxNodes: 2
    });
    assert.ok(small.nodes.length <= 2);
    assert.ok(small.edges.every((edge) =>
      small.nodes.some((node) => node.id === edge.from)
      && small.nodes.some((node) => node.id === edge.to)
    ));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("graph-html and locate CLI produce offline local artifacts", async () => {
  const root = await makeRepo();
  try {
    const indexDir = publicDir(root);
    const publicIndex = await readPublicIndexV1(indexDir);
    const entry = publicIndex.nodes.find((node) =>
      node.kind === "entry" && node.entry_name === "@daily"
    );
    assert.ok(entry);
    const out = path.join(root, "graph.html");

    const result = await exportGraphHtml({
      repoRoot: root,
      indexDir,
      outFile: out,
      focusNodeId: entry.id,
      maxNodes: 20,
      maxHops: 3
    });
    assert.equal(result.ok, true);
    assert.ok(result.nodes > 0);
    assert.ok(result.edges > 0);

    const html = await fs.readFile(out, "utf8");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /CCE Graph Viewer/);
    assert.match(html, /id="cce-data" type="application\/json"/);
    assert.match(html, /entry_handler/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /model\.nodes\.map\(n=>\[n\.id,n\]\)/);
    assert.equal(/<script\s+[^>]*src=/i.test(html), false);
    assert.equal(/<link\s+[^>]*href=/i.test(html), false);
    assert.equal(/https:\/\//i.test(html), false);

    const cliGraph = path.join(root, "cli-graph.html");
    const graphRun = await exec(process.execPath, [
      "src/cli.js",
      "graph-html",
      "--repo", root,
      "--out", cliGraph,
      "--focus", entry.id,
      "--max-nodes", "20",
      "--max-hops", "3"
    ], {
      cwd: new URL("..", import.meta.url),
      timeout: 120000,
      maxBuffer: 1024 * 1024
    });
    const graphJson = JSON.parse(graphRun.stdout);
    assert.equal(graphJson.ok, true);
    assert.equal(path.resolve(graphJson.path), path.resolve(cliGraph));

    const symbol = publicIndex.nodes.find((node) =>
      node.kind === "symbol" && node.name === "Handle"
    );
    const locateRun = await exec(process.execPath, [
      "src/cli.js",
      "locate",
      "--repo", root,
      "--node", symbol.id,
      "--editor", "file"
    ], {
      cwd: new URL("..", import.meta.url),
      timeout: 120000,
      maxBuffer: 1024 * 1024
    });
    const locateJson = JSON.parse(locateRun.stdout);
    assert.equal(locateJson.found, true);
    assert.match(locateJson.locations[0].open_uri, /^file:/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
