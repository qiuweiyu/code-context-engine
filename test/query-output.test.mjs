import test from "node:test";
import assert from "node:assert/strict";
import {
  projectQueryOutput,
  serializeQueryOutput
} from "../src/context/query-output.js";

function fullResult() {
  return {
    ok: true,
    task: "historical class assignment",
    terms: ["historical", "class"],
    query_expansion: {
      applied_aliases: [{ source: "builtin", key: "class" }],
      project_terms: [],
      retrieval_mode: "lexical",
      graph_seed_nodes: ["symbol:seed"]
    },
    graph_expansion: { added_files: 4, forward_steps: [{ hop: 1 }] },
    selection: { intent_reserved_files: ["backend/classroom.go"] },
    features: [{ id: "classroom" }],
    must_read: [{
      path: "backend/classroom.go",
      score: 118,
      reasons: ["symbol_match", "graph_reverse:call"],
      symbols: [
        "go:backend/classroom.go::*Repository.ListMine",
        "go:backend/classroom.go::*Repository.DetailForTeacher",
        "go:backend/classroom.go::qualifiedAssignment",
        "go:backend/classroom.go::validateAssignment",
        "go:backend/classroom.go::scanAssignment",
        "go:backend/classroom.go::mapNoRows",
        "go:backend/classroom.go::*Repository.Update",
        "go:backend/classroom.go::*Repository.ListMine"
      ]
    }],
    maybe_read: [{
      path: "admin/classroom.ts",
      score: 42,
      reasons: ["path_match"],
      symbols: [
        "typescript:admin/classroom.ts::listClasses",
        "typescript:admin/classroom.ts::getClass",
        "typescript:admin/classroom.ts::classError",
        "typescript:admin/classroom.ts::unusedFourth"
      ]
    }],
    symbols: [{ symbol_id: "go:backend/classroom.go::*Repository.ListMine" }],
    tests: ["backend/classroom_test.go", "admin/classroom.test.ts"],
    coverage: {
      candidate_files: 122,
      selected_files: 12,
      exact_feature_hits: 1,
      strong_symbol_hits: 284,
      status: "broad"
    },
    semantic_refinement_recommended: true
  };
}

test("full query output remains the original object and serialization", () => {
  const full = fullResult();
  assert.strictEqual(projectQueryOutput(full), full);
  assert.equal(serializeQueryOutput(full), JSON.stringify(full, null, 2));
});

test("compact query output keeps LLM navigation facts and removes debug payload", () => {
  const compact = projectQueryOutput(fullResult(), { compact: true });

  assert.deepEqual(compact.coverage, {
    status: "broad",
    candidate_files: 122,
    selected_files: 12
  });
  assert.equal(compact.retrieval_mode, "lexical");
  assert.deepEqual(compact.must_read.map((entry) => entry.path), ["backend/classroom.go"]);
  assert.deepEqual(compact.maybe_read.map((entry) => entry.path), ["admin/classroom.ts"]);
  assert.deepEqual(compact.tests, ["backend/classroom_test.go", "admin/classroom.test.ts"]);
  assert.deepEqual(compact.must_read[0].symbols, [
    "*Repository.ListMine",
    "*Repository.DetailForTeacher",
    "qualifiedAssignment",
    "validateAssignment",
    "scanAssignment",
    "mapNoRows"
  ]);
  assert.deepEqual(compact.maybe_read[0].symbols, [
    "listClasses",
    "getClass",
    "classError"
  ]);
  assert.equal("reasons" in compact.must_read[0], false);
  assert.equal("query_expansion" in compact, false);
  assert.equal("graph_expansion" in compact, false);
  assert.equal("selection" in compact, false);
  assert.equal("features" in compact, false);
  assert.equal("symbols" in compact, false);
});

test("compact query serialization is deterministic and minified", () => {
  const full = fullResult();
  const first = serializeQueryOutput(full, { compact: true });
  const second = serializeQueryOutput(full, { compact: true });

  assert.equal(first, second);
  assert.equal(first.includes("\n"), false);
  assert.deepEqual(JSON.parse(first), projectQueryOutput(full, { compact: true }));
});
