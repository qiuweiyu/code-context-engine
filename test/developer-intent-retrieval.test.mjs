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

async function write(root, relPath, body) {
  const full = path.join(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-developer-intent-"));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");

  await write(root, "src/cli.js", [
    "export function runCli(args) {",
    "  return args.includes('--semantic-provider') ? 'semantic provider' : 'deterministic';",
    "}"
  ].join("\n") + "\n");
  await write(root, "src/server.js", [
    "export function registerMcpTools() {",
    "  return ['context_query', 'semantic provider'];",
    "}"
  ].join("\n") + "\n");
  await write(root, "src/semantic/spec-path.js", "export function loadSemanticProviderSpec() { return 'semantic provider'; }\n");
  await write(root, "src/semantic/provider-v1.js", "export function runSemanticProviderV1() { return 'semantic provider'; }\n");
  await write(root, "src/semantic/rerank-v1.js", "export function rerankSemanticCandidatesV1() { return 'semantic provider'; }\n");
  await write(root, "src/context/retriever.js", "export function queryContextWithSemantic() { return 'semantic provider'; }\n");
  await write(root, "src/context/client-requests.js", [
    "export function normalizeClientPath() { return 'semantic provider cli'; }",
    "export function extractClientRoutes() { return normalizeClientPath(); }"
  ].join("\n") + "\n");
  await write(root, "benchmarks/fixtures/cmd/worker.js", [
    "export function semanticProviderCliCommand() { return 'semantic provider command cli mcp'; }",
    "export function semanticProviderCliCommandRunner() { return semanticProviderCliCommand(); }"
  ].join("\n") + "\n");

  for (let i = 0; i < 10; i++) {
    await write(
      root,
      `src/semantic/provider-noise-${i}.js`,
      `export function semanticProviderNoise${i}() { return 'semantic provider'; }\n`
    );
  }

  await write(root, "package.json", JSON.stringify({
    name: "developer-intent-fixture",
    version: "0.2.0",
    type: "module"
  }, null, 2) + "\n");
  await write(root, "test/flow-surface.test.mjs", [
    "import test from 'node:test';",
    "test('CLI version uses src/cli.js --version', () => {",
    "  const command = 'node src/cli.js --version';",
    "  if (!command.includes('cli.js')) throw new Error('missing cli');",
    "});"
  ].join("\n") + "\n");
  await write(root, "test/provider-only.test.mjs", [
    "import test from 'node:test';",
    "test('semantic provider implementation', () => {",
    "  const subject = 'semantic provider';",
    "  if (!subject) throw new Error('missing subject');",
    "});"
  ].join("\n") + "\n");

  await git(root, "add", ".");
  await git(root, "commit", "-qm", "fixture");
  await indexRepository({ repoRoot: root });
  return root;
}

test("developer intent reserves CLI and MCP entry surfaces for the real semantic-provider query", async () => {
  const root = await createFixture();
  try {
    const result = queryContext({
      repoRoot: root,
      task: "查找 Semantic Provider 的 CLI 和 MCP 接入代码",
      maxFiles: 6
    });

    const mustRead = result.must_read.map((entry) => entry.path);
    assert.ok(mustRead.includes("src/cli.js"), JSON.stringify(result.must_read));
    assert.ok(mustRead.includes("src/server.js"), JSON.stringify(result.must_read));
    assert.ok(result.selection.intent_reserved_files.includes("src/cli.js"));
    assert.ok(result.selection.intent_reserved_files.includes("src/server.js"));
    assert.ok(!result.selection.intent_reserved_files.includes("src/context/client-requests.js"));
    assert.ok(!result.selection.intent_reserved_files.includes("benchmarks/fixtures/cmd/worker.js"));

    const developerAliases = result.query_expansion.applied_aliases
      .filter((entry) => entry.source === "developer")
      .map((entry) => entry.key);
    assert.ok(developerAliases.includes("cli"));
    assert.ok(developerAliases.includes("mcp"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI version task retrieves CLI, manifest and relevant test surfaces together", async () => {
  const root = await createFixture();
  try {
    const result = queryContext({
      repoRoot: root,
      task: "为 CCE CLI 增加 --version 参数，并增加对应自动化测试",
      maxFiles: 6
    });

    assert.ok(
      result.must_read.some((entry) => entry.path === "src/cli.js"),
      JSON.stringify({ must_read: result.must_read, maybe_read: result.maybe_read })
    );
    assert.ok(
      result.must_read.some((entry) => entry.path === "package.json"),
      JSON.stringify({ must_read: result.must_read, maybe_read: result.maybe_read })
    );
    assert.ok(result.tests.includes("test/flow-surface.test.mjs"), JSON.stringify(result.tests));
    assert.ok(!result.tests.includes("test/provider-only.test.mjs"), JSON.stringify(result.tests));
    assert.ok(result.selection.intent_reserved_files.includes("src/cli.js"));
    assert.deepEqual(result.selection.manifest_reserved_files, ["package.json"]);
    assert.deepEqual(result.selection.test_reserved_files, ["test/flow-surface.test.mjs"]);
    assert.ok(result.graph_expansion.manifest_surface_files >= 1);
    assert.ok(result.graph_expansion.direct_test_files >= 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("test surface channel stays disabled when the query does not request tests", async () => {
  const root = await createFixture();
  try {
    const result = queryContext({
      repoRoot: root,
      task: "查找 Semantic Provider 的 CLI 和 MCP 接入代码",
      maxFiles: 6
    });

    assert.equal(result.graph_expansion.direct_test_files, 0);
    assert.deepEqual(result.selection.test_reserved_files, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
