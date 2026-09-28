import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { indexRepository } from "../src/context/indexer.js";
import { queryContext } from "../src/context/retriever.js";
import { readIndexStatus } from "../src/context/status.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexDir = await fs.mkdtemp(path.join(os.tmpdir(), "cce-codex-acceptance-"));
const probeRel = "test/wp19d-working-tree-probe.test.mjs";
const probeFull = path.join(repoRoot, ...probeRel.split("/"));

async function git(...args) {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true
  });
  return stdout.trim();
}

function paths(entries = []) {
  return entries.map((entry) => entry.path);
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function restoreFile(file, original) {
  if (original === null) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, original);
}

let excludePath;
let originalExclude;
try {
  const first = await indexRepository({ repoRoot, indexDir, force: true });
  const second = await indexRepository({ repoRoot, indexDir });

  assert.equal(second.changed_files, 0, JSON.stringify(second));
  assert.equal(second.removed_files, 0, JSON.stringify(second));

  const initialStatus = await readIndexStatus({ repoRoot, indexDir });
  assert.equal(initialStatus.stale, false, JSON.stringify(initialStatus));
  assert.ok(initialStatus.runtime.runtime_fingerprint, JSON.stringify(initialStatus));
  assert.equal(
    initialStatus.index_provenance.indexed_runtime_fingerprint,
    initialStatus.runtime.runtime_fingerprint,
    JSON.stringify(initialStatus)
  );

  const semanticTask = "查找 Semantic Provider 的 CLI 和 MCP 接入代码";
  const semantic = queryContext({
    repoRoot,
    task: semanticTask,
    indexDir,
    maxFiles: 12
  });
  const semanticMustRead = paths(semantic.must_read);
  assert.ok(semanticMustRead.includes("src/cli.js"), JSON.stringify(semantic));
  assert.ok(semanticMustRead.includes("src/server.js"), JSON.stringify(semantic));

  const cliTask = "为 CCE CLI 增加 --version 参数，并增加对应自动化测试";
  const cli = queryContext({
    repoRoot,
    task: cliTask,
    indexDir,
    maxFiles: 12
  });
  const cliMustRead = paths(cli.must_read);
  assert.ok(cliMustRead.includes("src/cli.js"), JSON.stringify(cli));
  assert.ok(cliMustRead.includes("package.json"), JSON.stringify(cli));
  assert.ok(cli.selection.manifest_reserved_files.includes("package.json"), JSON.stringify(cli));
  assert.ok(cli.tests.length > 0, JSON.stringify(cli));

  let cliRelatedTest = false;
  for (const rel of cli.tests) {
    const body = (await fs.readFile(path.join(repoRoot, ...rel.split("/")), "utf8")).toLowerCase();
    if (body.includes("src/cli.js") || body.includes("cli")) {
      cliRelatedTest = true;
      break;
    }
  }
  assert.ok(cliRelatedTest, JSON.stringify(cli.tests));

  await fs.writeFile(
    probeFull,
    [
      "import test from 'node:test';",
      "test('wp19d working tree probe for CLI version acceptance', () => {",
      "  const wp19dWorkingTreeProbe = 'cli version acceptance';",
      "  if (!wp19dWorkingTreeProbe.includes('cli')) throw new Error('probe failed');",
      "});",
      ""
    ].join("\n")
  );

  const staleWithProbe = await readIndexStatus({ repoRoot, indexDir });
  assert.equal(staleWithProbe.stale, true, JSON.stringify(staleWithProbe));
  assert.ok(
    staleWithProbe.freshness.reasons.added_files >= 1,
    JSON.stringify(staleWithProbe)
  );
  assert.ok(
    staleWithProbe.freshness.samples.added_files.includes(probeRel),
    JSON.stringify(staleWithProbe)
  );

  const withProbe = await indexRepository({ repoRoot, indexDir });
  assert.ok(withProbe.changed_files >= 1, JSON.stringify(withProbe));
  assert.equal(withProbe.analysis_failed_files, 0, JSON.stringify(withProbe));
  const freshWithProbe = await readIndexStatus({ repoRoot, indexDir });
  assert.equal(freshWithProbe.stale, false, JSON.stringify(freshWithProbe));

  const probeTask = "查找 wp19d working tree probe 的测试代码";
  const probeQuery = queryContext({
    repoRoot,
    task: probeTask,
    indexDir,
    maxFiles: 8
  });
  assert.ok(probeQuery.tests.includes(probeRel), JSON.stringify(probeQuery));

  const gitPath = await git("rev-parse", "--git-path", "info/exclude");
  excludePath = path.isAbsolute(gitPath) ? gitPath : path.resolve(repoRoot, gitPath);
  originalExclude = await readIfExists(excludePath);
  const currentExclude = originalExclude ?? "";
  const suffix = currentExclude.endsWith("\n") || currentExclude.length === 0 ? "" : "\n";
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, currentExclude + suffix + "/" + probeRel + "\n");

  const staleAfterIgnore = await readIndexStatus({ repoRoot, indexDir });
  assert.equal(staleAfterIgnore.stale, true, JSON.stringify(staleAfterIgnore));
  assert.ok(
    staleAfterIgnore.freshness.reasons.removed_files >= 1,
    JSON.stringify(staleAfterIgnore)
  );
  assert.ok(
    staleAfterIgnore.freshness.samples.removed_files.includes(probeRel),
    JSON.stringify(staleAfterIgnore)
  );

  const ignored = await indexRepository({ repoRoot, indexDir });
  assert.ok(ignored.removed_files >= 1, JSON.stringify(ignored));
  assert.equal(ignored.analysis_failed_files, 0, JSON.stringify(ignored));
  const freshAfterIgnore = await readIndexStatus({ repoRoot, indexDir });
  assert.equal(freshAfterIgnore.stale, false, JSON.stringify(freshAfterIgnore));

  const ignoredQuery = queryContext({
    repoRoot,
    task: probeTask,
    indexDir,
    maxFiles: 8
  });
  assert.ok(!ignoredQuery.tests.includes(probeRel), JSON.stringify(ignoredQuery));

  process.stdout.write(JSON.stringify({
    ok: true,
    repository: repoRoot,
    initial_index: {
      changed_files: first.changed_files,
      second_changed_files: second.changed_files
    },
    queries: [
      {
        task: semanticTask,
        must_read: semanticMustRead,
        tests: semantic.tests
      },
      {
        task: cliTask,
        must_read: cliMustRead,
        tests: cli.tests,
        manifest_reserved_files: cli.selection.manifest_reserved_files
      }
    ],
    freshness: {
      initial_stale: initialStatus.stale,
      stale_before_probe_reindex: staleWithProbe.stale,
      fresh_after_probe_reindex: !freshWithProbe.stale,
      stale_after_local_ignore: staleAfterIgnore.stale,
      fresh_after_ignore_reindex: !freshAfterIgnore.stale,
      runtime_fingerprint: initialStatus.runtime.runtime_fingerprint
    },
    working_tree: {
      probe: probeRel,
      indexed_before_git_add: true,
      reanalyzed_files_after_probe: withProbe.changed_files,
      query_selected_probe: true,
      removed_after_local_ignore: true,
      reanalyzed_files_after_ignore: ignored.changed_files
    }
  }, null, 2) + "\n");
} finally {
  await fs.rm(probeFull, { force: true });
  if (excludePath !== undefined) {
    await restoreFile(excludePath, originalExclude);
  }
  await fs.rm(indexDir, { recursive: true, force: true });
}
