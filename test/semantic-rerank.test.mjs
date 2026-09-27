import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { indexRepository } from "../src/context/indexer.js";
import {
  queryContext,
  queryContextWithSemantic
} from "../src/context/retriever.js";
import {
  rerankSemanticCandidatesV1,
  semanticCandidatePoolLimit
} from "../src/semantic/rerank-v1.js";

const execFileAsync = promisify(execFile);
const fixturePath = fileURLToPath(
  new URL("./fixtures/semantic-provider-fixture.mjs", import.meta.url)
);

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], { windowsHide: true });
}

function fixtureSpec(mode = "success", overrides = {}) {
  return {
    protocol: "cce.semantic-provider-spec",
    version: "1.0",
    command: process.execPath,
    args: [fixturePath, mode],
    timeout_ms: 500,
    weight: 0.35,
    ...overrides
  };
}

function selectedPaths(result) {
  return [...result.must_read, ...result.maybe_read, ...(result.tests ?? []).map((path) => ({ path }))]
    .map((entry) => entry.path);
}

function withoutSemanticRefinement(result) {
  const clone = structuredClone(result);
  delete clone.semantic_refinement;
  return clone;
}

test("semantic rerank is bounded, deterministic and cannot pull from outside the candidate prefix", () => {
  assert.equal(semanticCandidatePoolLimit(12, 200), 36);
  assert.equal(semanticCandidatePoolLimit(30, 200), 64);
  assert.equal(semanticCandidatePoolLimit(3, 4), 4);

  const rankedFiles = [
    { path: "src/alpha.js" },
    { path: "src/beta.js" },
    { path: "src/gamma.js" },
    { path: "src/semantic-target.js" },
    { path: "src/outside-prefix.js" }
  ];
  const scores = [
    { path: "src/alpha.js", semantic_score: 0.1 },
    { path: "src/beta.js", semantic_score: 0.11 },
    { path: "src/gamma.js", semantic_score: 0.12 },
    { path: "src/semantic-target.js", semantic_score: 0.95 }
  ];

  const first = rerankSemanticCandidatesV1({
    rankedFiles,
    scores,
    weight: 0.35,
    poolSize: 4
  });
  const second = rerankSemanticCandidatesV1({
    rankedFiles,
    scores,
    weight: 0.35,
    poolSize: 4
  });

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.ranked_files.map((entry) => entry.path),
    [
      "src/alpha.js",
      "src/beta.js",
      "src/semantic-target.js",
      "src/gamma.js",
      "src/outside-prefix.js"
    ]
  );
  assert.equal(first.refinements.find((entry) => entry.path === "src/semantic-target.js").semantic_rank, 3);
  assert.equal(first.refinements.some((entry) => entry.path === "src/outside-prefix.js"), false);
});

test("semantic query path preserves OFF behavior, reranks bounded candidates ON, and falls back exactly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-semantic-rerank-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    const files = [
      ["alpha.js", "publishHomeworkAlpha"],
      ["beta.js", "publishHomeworkBeta"],
      ["gamma.js", "publishHomeworkGamma"],
      ["semantic-target.js", "publishHomeworkSemantic"]
    ];
    for (const [name, fn] of files) {
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

    const options = {
      repoRoot: root,
      task: "publish homework",
      maxFiles: 3
    };
    const deterministic = queryContext(options);
    const semanticDisabled = await queryContextWithSemantic(options);
    assert.deepEqual(semanticDisabled, deterministic);
    assert.equal(JSON.stringify(semanticDisabled), JSON.stringify(deterministic));
    assert.equal("semantic_refinement" in deterministic, false);

    const deterministicSelected = selectedPaths(deterministic);
    assert.deepEqual(deterministicSelected, [
      "src/alpha.js",
      "src/beta.js",
      "src/gamma.js"
    ]);
    assert.equal(deterministicSelected.includes("src/semantic-target.js"), false);

    const applied = await queryContextWithSemantic({
      ...options,
      semanticProviderSpec: fixtureSpec("success")
    });
    assert.equal(applied.semantic_refinement.status, "applied");
    assert.equal(applied.semantic_refinement.weight, 0.35);
    assert.equal(applied.semantic_refinement.candidate_count, 4);
    assert.equal(applied.coverage.candidate_files, deterministic.coverage.candidate_files);
    assert.equal(applied.coverage.selected_files, deterministic.coverage.selected_files);

    const appliedSelected = selectedPaths(applied);
    assert.deepEqual(appliedSelected, [
      "src/alpha.js",
      "src/beta.js",
      "src/semantic-target.js"
    ]);
    const target = applied.semantic_refinement.selected.find(
      (entry) => entry.path === "src/semantic-target.js"
    );
    assert.ok(target);
    assert.equal(target.deterministic_rank, 4);
    assert.equal(target.semantic_rank, 3);
    assert.equal(target.semantic_score, 0.95);

    const fallback = await queryContextWithSemantic({
      ...options,
      semanticProviderSpec: fixtureSpec("invalid-json")
    });
    assert.equal(fallback.semantic_refinement.status, "fallback");
    assert.equal(fallback.semantic_refinement.error.code, "invalid_json");
    assert.deepEqual(withoutSemanticRefinement(fallback), deterministic);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
