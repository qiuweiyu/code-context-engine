import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEMANTIC_PROVIDER_PROTOCOL,
  SEMANTIC_PROVIDER_VERSION,
  SEMANTIC_PROVIDER_SPEC_PROTOCOL,
  SEMANTIC_PROVIDER_SPEC_VERSION,
  SEMANTIC_PROVIDER_DEFAULT_TIMEOUT_MS,
  SEMANTIC_PROVIDER_DEFAULT_WEIGHT,
  createSemanticProviderRequestV1,
  loadSemanticProviderSpecV1,
  runSemanticProviderV1,
  validateSemanticProviderRequestV1,
  validateSemanticProviderResponseV1,
  validateSemanticProviderSpecV1
} from "../src/semantic/provider-v1.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/semantic-provider-fixture.mjs", import.meta.url)
);

function fixtureSpec(mode = "success", overrides = {}) {
  return {
    protocol: SEMANTIC_PROVIDER_SPEC_PROTOCOL,
    version: SEMANTIC_PROVIDER_SPEC_VERSION,
    command: process.execPath,
    args: [fixturePath, mode],
    timeout_ms: 500,
    weight: 0.25,
    ...overrides
  };
}

function sampleRequest(requestId = "req-semantic-1") {
  return createSemanticProviderRequestV1({
    requestId,
    task: "find the code that publishes homework",
    candidates: [
      {
        path: "src/ordinary.js",
        score: 30,
        reasons: ["symbol_match"],
        symbols: new Set(["symbol:javascript:src/ordinary.js::ordinary"])
      },
      {
        path: "src/semantic-target.js",
        score: 20,
        reasons: ["path_match", "caller_of:x"],
        symbols: ["symbol:javascript:src/semantic-target.js::HomeworkService.publish"]
      }
    ]
  });
}

test("Semantic Provider v1 validates and normalizes provider specs", () => {
  const normalized = validateSemanticProviderSpecV1({
    protocol: SEMANTIC_PROVIDER_SPEC_PROTOCOL,
    version: SEMANTIC_PROVIDER_SPEC_VERSION,
    command: process.execPath
  });
  assert.equal(normalized.timeout_ms, SEMANTIC_PROVIDER_DEFAULT_TIMEOUT_MS);
  assert.equal(normalized.weight, SEMANTIC_PROVIDER_DEFAULT_WEIGHT);
  assert.deepEqual(normalized.args, []);

  assert.throws(() => validateSemanticProviderSpecV1({
    ...normalized,
    weight: 0.351
  }), /weight is outside/);
  assert.throws(() => validateSemanticProviderSpecV1({
    ...normalized,
    shell: true
  }), /unsupported field: shell/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cce-semantic-spec-"));
  try {
    const specFile = path.join(dir, "provider.json");
    fs.writeFileSync(specFile, JSON.stringify({
      protocol: SEMANTIC_PROVIDER_SPEC_PROTOCOL,
      version: SEMANTIC_PROVIDER_SPEC_VERSION,
      command: process.execPath,
      args: [fixturePath, "success"],
      timeout_ms: 250,
      weight: 0.2
    }));
    const loaded = loadSemanticProviderSpecV1(specFile);
    assert.equal(loaded.timeout_ms, 250);
    assert.equal(loaded.weight, 0.2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Semantic Provider request builder exposes bounded metadata but never candidate source bodies", () => {
  const sourceSecret = "SOURCE_BODY_MUST_NEVER_LEAVE_CCE";
  const request = createSemanticProviderRequestV1({
    requestId: "privacy-1",
    task: "find homework publication",
    candidates: [{
      path: "src/homework.js",
      score: 17,
      reasons: ["symbol_match"],
      symbols: ["symbol:javascript:src/homework.js::HomeworkService.publish"],
      content: sourceSecret,
      source: sourceSecret,
      arbitrary_file_body: sourceSecret
    }]
  });

  assert.deepEqual(request, {
    protocol: SEMANTIC_PROVIDER_PROTOCOL,
    version: SEMANTIC_PROVIDER_VERSION,
    request_id: "privacy-1",
    task: "find homework publication",
    candidates: [{
      path: "src/homework.js",
      deterministic_rank: 1,
      deterministic_score: 17,
      reasons: ["symbol_match"],
      symbol_hints: ["HomeworkService.publish"]
    }]
  });
  assert.equal(JSON.stringify(request).includes(sourceSecret), false);
  validateSemanticProviderRequestV1(request);

  assert.throws(() => createSemanticProviderRequestV1({
    requestId: "unsafe-path",
    task: "x",
    candidates: [{ path: "../secret.env", score: 1 }]
  }), /invalid path components/);

  assert.throws(() => validateSemanticProviderRequestV1({
    ...request,
    source: "not allowed"
  }), /unsupported field: source/);
});

test("Semantic Provider response validator requires exact candidate coverage and identity", () => {
  const request = sampleRequest("response-1");
  const valid = {
    protocol: SEMANTIC_PROVIDER_PROTOCOL,
    version: SEMANTIC_PROVIDER_VERSION,
    request_id: request.request_id,
    provider: { id: "fixture.semantic", version: "1.0.0" },
    scores: request.candidates.map((candidate, index) => ({
      path: candidate.path,
      semantic_score: index === 1 ? 0.95 : 0.1,
      reason: "fixture"
    })),
    diagnostics: []
  };
  assert.equal(validateSemanticProviderResponseV1(valid, request), valid);

  assert.throws(() => validateSemanticProviderResponseV1({
    ...valid,
    scores: [
      ...valid.scores.slice(0, 1),
      { path: "src/injected.js", semantic_score: 1 }
    ]
  }, request), /unknown candidate path/);

  assert.throws(() => validateSemanticProviderResponseV1({
    ...valid,
    scores: [valid.scores[0], { ...valid.scores[0] }]
  }, request), /duplicate semantic provider score path/);

  assert.throws(() => validateSemanticProviderResponseV1({
    ...valid,
    scores: valid.scores.slice(0, 1)
  }, request), /score every candidate exactly once/);

  assert.throws(() => validateSemanticProviderResponseV1({
    ...valid,
    request_id: "other-request"
  }, request), /request_id mismatch/);

  assert.throws(() => validateSemanticProviderResponseV1({
    ...valid,
    version: "1.1"
  }, request), /version mismatch/);
});

test("Semantic Provider runner applies a valid deterministic fixture response", async () => {
  const request = sampleRequest("runner-success");
  const result = await runSemanticProviderV1({
    spec: fixtureSpec("success"),
    request
  });

  assert.equal(result.status, "applied");
  assert.deepEqual(result.provider, {
    id: "fixture.semantic",
    version: "1.0.0"
  });
  assert.equal(result.scores.length, request.candidates.length);
  assert.equal(
    result.scores.find((score) => score.path === "src/semantic-target.js")?.semantic_score,
    0.95
  );
  assert.ok(result.duration_ms >= 0);
});

test("Semantic Provider runner falls back on provider failures without throwing", async () => {
  const request = sampleRequest("runner-fallback");

  const cases = [
    ["unknown-path", {}, "invalid_response"],
    ["duplicate-path", {}, "invalid_response"],
    ["partial", {}, "invalid_response"],
    ["wrong-request", {}, "invalid_response"],
    ["invalid-json", {}, "invalid_json"],
    ["crash", {}, "exit_nonzero"],
    ["timeout", { timeout_ms: 100 }, "timeout"]
  ];

  for (const [mode, overrides, expectedCode] of cases) {
    const result = await runSemanticProviderV1({
      spec: fixtureSpec(mode, overrides),
      request
    });
    assert.equal(result.status, "fallback", mode);
    assert.equal(result.error.code, expectedCode, mode);
  }

  const invalidSpec = await runSemanticProviderV1({
    spec: { ...fixtureSpec(), weight: 0.9 },
    request
  });
  assert.equal(invalidSpec.status, "fallback");
  assert.equal(invalidSpec.error.code, "invalid_spec");

  const invalidRequest = await runSemanticProviderV1({
    spec: fixtureSpec(),
    request: { ...request, source: "forbidden" }
  });
  assert.equal(invalidRequest.status, "fallback");
  assert.equal(invalidRequest.error.code, "invalid_request");
});
