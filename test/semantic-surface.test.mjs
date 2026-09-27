import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { indexRepository } from "../src/context/indexer.js";
import { queryContext } from "../src/context/retriever.js";
import { serializeQueryOutput } from "../src/context/query-output.js";
import {
  loadCliSemanticProviderSpecV1,
  loadMcpSemanticProviderSpecV1
} from "../src/semantic/spec-path.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = fileURLToPath(
  new URL("./fixtures/semantic-provider-fixture.mjs", import.meta.url)
);

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], { windowsHide: true });
}

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-semantic-surface-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });

  for (const [name, fn] of [
    ["alpha.js", "publishHomeworkAlpha"],
    ["beta.js", "publishHomeworkBeta"],
    ["gamma.js", "publishHomeworkGamma"],
    ["semantic-target.js", "publishHomeworkSemantic"]
  ]) {
    await fs.writeFile(
      path.join(root, "src", name),
      [
        `export function ${fn}() {`,
        "  return 'ok';",
        "}",
        ""
      ].join("\n")
    );
  }

  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "init");
  await indexRepository({ repoRoot: root });

  const spec = {
    protocol: "cce.semantic-provider-spec",
    version: "1.0",
    command: process.execPath,
    args: [fixturePath, "success"],
    timeout_ms: 500,
    weight: 0.35
  };
  await fs.mkdir(path.join(root, ".cce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".cce", "semantic-provider.json"),
    JSON.stringify(spec, null, 2)
  );
  return root;
}

function parseMcpText(result) {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

test("Semantic Provider spec paths allow CLI local files but MCP stays inside repo_root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-semantic-spec-path-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cce-semantic-spec-outside-"));
  try {
    const spec = {
      protocol: "cce.semantic-provider-spec",
      version: "1.0",
      command: process.execPath
    };
    const insideFile = path.join(root, "provider.json");
    const outsideFile = path.join(outside, "provider.json");
    await fs.writeFile(insideFile, JSON.stringify(spec));
    await fs.writeFile(outsideFile, JSON.stringify(spec));

    assert.equal(loadCliSemanticProviderSpecV1(outsideFile).command, process.execPath);
    assert.equal(
      loadMcpSemanticProviderSpecV1({ repoRoot: root, specPath: "provider.json" }).command,
      process.execPath
    );
    assert.throws(
      () => loadMcpSemanticProviderSpecV1({
        repoRoot: root,
        specPath: path.relative(root, outsideFile)
      }),
      /must be inside repo_root/
    );
    assert.throws(
      () => loadMcpSemanticProviderSpecV1({
        repoRoot: root,
        specPath: outsideFile
      }),
      /must be inside repo_root/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("query CLI keeps default serialization unchanged and applies semantic provider only with explicit flag", async () => {
  const root = await makeRepo();
  try {
    const options = { repoRoot: root, task: "publish homework", maxFiles: 3 };
    const deterministic = queryContext(options);
    const expectedDefault = serializeQueryOutput(deterministic) + "\n";

    const defaultRun = await execFileAsync(
      process.execPath,
      [
        path.join(projectRoot, "src/cli.js"),
        "query",
        "--repo", root,
        "--task", "publish homework",
        "--max-files", "3"
      ],
      {
        cwd: projectRoot,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }
    );
    assert.equal(defaultRun.stdout, expectedDefault);
    assert.equal(JSON.parse(defaultRun.stdout).semantic_refinement, undefined);

    const appliedRun = await execFileAsync(
      process.execPath,
      [
        path.join(projectRoot, "src/cli.js"),
        "query",
        "--repo", root,
        "--task", "publish homework",
        "--max-files", "3",
        "--semantic-provider", path.join(root, ".cce", "semantic-provider.json")
      ],
      {
        cwd: projectRoot,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }
    );
    const applied = JSON.parse(appliedRun.stdout);
    assert.equal(applied.semantic_refinement.status, "applied");
    assert.equal(applied.semantic_refinement.provider.id, "fixture.semantic");
    assert.equal(
      [...applied.must_read, ...applied.maybe_read]
        .some((entry) => entry.path === "src/semantic-target.js"),
      true
    );

    const compactRun = await execFileAsync(
      process.execPath,
      [
        path.join(projectRoot, "src/cli.js"),
        "query",
        "--repo", root,
        "--task", "publish homework",
        "--max-files", "3",
        "--compact",
        "--semantic-provider", path.join(root, ".cce", "semantic-provider.json")
      ],
      {
        cwd: projectRoot,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }
    );
    const compact = JSON.parse(compactRun.stdout);
    assert.deepEqual(compact.semantic_refinement, {
      status: "applied",
      provider: "fixture.semantic"
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MCP context_query defaults to deterministic retrieval and requires explicit in-repo semantic provider", async () => {
  const root = await makeRepo();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src/server.js")],
    env: {
      ...process.env,
      CCE_ALLOWED_ROOTS: root
    },
    stderr: "pipe"
  });
  const client = new Client(
    { name: "cce-semantic-surface-test", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);

    const deterministicCall = await client.callTool({
      name: "context_query",
      arguments: {
        repo_root: root,
        task: "publish homework",
        max_files: 3
      }
    });
    const deterministic = parseMcpText(deterministicCall);
    assert.equal(deterministic.ok, true);
    assert.equal(deterministic.semantic_refinement, undefined);

    const appliedCall = await client.callTool({
      name: "context_query",
      arguments: {
        repo_root: root,
        task: "publish homework",
        max_files: 3,
        compact: true,
        semantic_provider: ".cce/semantic-provider.json"
      }
    });
    const applied = parseMcpText(appliedCall);
    assert.deepEqual(applied.semantic_refinement, {
      status: "applied",
      provider: "fixture.semantic"
    });
    assert.equal(
      [...applied.must_read, ...applied.maybe_read]
        .some((entry) => entry.path === "src/semantic-target.js"),
      true
    );

    const rejectedCall = await client.callTool({
      name: "context_query",
      arguments: {
        repo_root: root,
        task: "publish homework",
        semantic_provider: "../outside-provider.json"
      }
    });
    const rejected = parseMcpText(rejectedCall);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /must be inside repo_root/);
  } finally {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
