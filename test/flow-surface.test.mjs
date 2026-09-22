import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepository } from "../src/context/indexer.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], { windowsHide: true });
}

test("flow CLI emits a compact manifest from an indexed generic fixture", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-flow-cli-"));
  try {
    await fs.mkdir(path.join(root, "backend"), { recursive: true });
    await fs.mkdir(path.join(root, "web/api"), { recursive: true });

    await fs.writeFile(
      path.join(root, "backend/router.go"),
      [
        "package backend",
        "import \"net/http\"",
        "type Router struct{}",
        "type API struct{}",
        "func (api *API) Get(w http.ResponseWriter, r *http.Request) {}",
        "func register(router *Router, api *API) {",
        "  router.HandlePattern(http.MethodGet, \"/api/items/{item_id}\", http.HandlerFunc(api.Get))",
        "}"
      ].join("\n") + "\n"
    );

    await fs.writeFile(
      path.join(root, "web/api/items.ts"),
      [
        "const base = '/api/items'",
        "export async function getItem(id: string) {",
        "  return requestJson<unknown>(\`${base}/${id}\`, { method: 'GET' })",
        "}"
      ].join("\n") + "\n"
    );

    await git(root, "init", "-q");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "init");

    await indexRepository({ repoRoot: root });

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(projectRoot, "src/cli.js"),
        "flow",
        "--repo",
        root,
        "--start",
        "symbol:typescript:web/api/items.ts::getItem",
        "--max-hops",
        "2",
        "--edge-types",
        "api_request,route_handler"
      ],
      {
        cwd: projectRoot,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }
    );

    const manifest = JSON.parse(stdout);
    assert.equal(manifest.ok, true);
    assert.equal(manifest.manifest_version, 1);
    assert.equal(manifest.summary.flow_count, 1);
    assert.deepEqual(
      manifest.flows[0].steps.map((step) => step.type),
      ["api_request", "route_handler"]
    );
    assert.equal(
      manifest.flows[0].steps.at(-1).next_node_id,
      "symbol:go:backend/router.go::*API.Get"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI and MCP entry points pass Node syntax checks", async () => {
  for (const relativePath of ["src/cli.js", "src/server.js"]) {
    const result = await execFileAsync(
      process.execPath,
      ["--check", path.join(projectRoot, relativePath)],
      { cwd: projectRoot, windowsHide: true }
    );
    assert.equal(result.stderr, "");
  }
});
