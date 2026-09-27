import test from "node:test";
import assert from "node:assert/strict";
import {
  PLUGIN_PROTOCOL,
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_FACT_VERSION,
  createPluginAnalyzeRequestV1,
  validatePluginDescriptorV1,
  validatePluginAnalyzeRequestV1,
  validatePluginAnalyzeResultV1
} from "../src/plugin/v1.js";

test("Plugin Protocol v1 validates descriptor, request and result", () => {
  const descriptor = validatePluginDescriptorV1({
    protocol: PLUGIN_PROTOCOL,
    protocol_version: PLUGIN_PROTOCOL_VERSION,
    id: "example-python",
    version: "1.2.3",
    languages: ["python"],
    capabilities: {
      symbols: "static",
      imports: "static",
      calls: "heuristic",
      types: "unsupported"
    },
    future_optional_field: true
  });
  assert.equal(descriptor.future_optional_field, true);

  const request = createPluginAnalyzeRequestV1({
    requestId: "req-1",
    files: [{
      path: "src/app.py",
      language: "python",
      content: "def run():\n    pass\n"
    }],
    trackedFiles: ["src/app.py", "src/lib.py", "src/app.py"]
  });
  assert.equal(request.fact_version, PLUGIN_FACT_VERSION);
  assert.deepEqual(request.tracked_files, ["src/app.py", "src/lib.py"]);
  validatePluginAnalyzeRequestV1(request);

  const result = validatePluginAnalyzeResultV1({
    protocol: PLUGIN_PROTOCOL,
    protocol_version: PLUGIN_PROTOCOL_VERSION,
    fact_version: PLUGIN_FACT_VERSION,
    request_id: "req-1",
    files: [{
      path: "src/app.py",
      status: "complete",
      symbols: [{
        symbol_id: "app.run",
        name: "run",
        qualified_name: "run",
        kind: "function",
        line_start: 1,
        line_end: 2,
        future_optional_field: "allowed"
      }],
      dependencies: [{
        relation: "imports",
        to_ref: "lib",
        to_file: "src/lib.py"
      }],
      diagnostics: []
    }],
    future_optional_field: { allowed: true }
  });
  assert.equal(result.future_optional_field.allowed, true);
});

test("Plugin Protocol v1 rejects unsafe paths and incompatible versions", () => {
  assert.throws(() => createPluginAnalyzeRequestV1({
    requestId: "req-2",
    files: [{
      path: "../secret.py",
      language: "python",
      content: ""
    }]
  }), /invalid path components/);

  assert.throws(() => validatePluginDescriptorV1({
    protocol: PLUGIN_PROTOCOL,
    protocol_version: 2,
    id: "future",
    version: "2.0.0",
    languages: ["python"],
    capabilities: {}
  }), /unsupported plugin protocol version/);

  assert.throws(() => validatePluginAnalyzeResultV1({
    protocol: PLUGIN_PROTOCOL,
    protocol_version: 1,
    fact_version: "1.0.0",
    request_id: "req-3",
    files: [{
      path: "src/app.py",
      status: "complete",
      symbols: [],
      dependencies: [{ relation: "runtime_magic", to_ref: "x" }],
      diagnostics: []
    }]
  }), /unsupported plugin dependency relation/);
});

test("Plugin Protocol v1 rejects duplicate file and symbol identities", () => {
  assert.throws(() => validatePluginAnalyzeResultV1({
    protocol: PLUGIN_PROTOCOL,
    protocol_version: 1,
    fact_version: "1.0.0",
    request_id: "req-4",
    files: [{
      path: "src/app.py",
      status: "complete",
      symbols: [
        {
          symbol_id: "same",
          name: "a",
          qualified_name: "a",
          kind: "function",
          line_start: 1,
          line_end: 1
        },
        {
          symbol_id: "same",
          name: "b",
          qualified_name: "b",
          kind: "function",
          line_start: 2,
          line_end: 2
        }
      ],
      dependencies: [],
      diagnostics: []
    }]
  }), /duplicate plugin symbol id/);
});

test("Plugin Protocol v1 rejects missing source content and cross-file symbol ID collisions", () => {
  assert.throws(() => createPluginAnalyzeRequestV1({
    requestId: "req-5",
    files: [{
      path: "src/app.py",
      language: "python"
    }]
  }), /file content must be a string/);

  assert.throws(() => validatePluginAnalyzeResultV1({
    protocol: PLUGIN_PROTOCOL,
    protocol_version: 1,
    fact_version: "1.0.0",
    request_id: "req-6",
    files: [
      {
        path: "src/a.py",
        status: "complete",
        symbols: [{
          symbol_id: "shared.id",
          name: "a",
          qualified_name: "a",
          kind: "function",
          line_start: 1,
          line_end: 1
        }],
        dependencies: [],
        diagnostics: []
      },
      {
        path: "src/b.py",
        status: "complete",
        symbols: [{
          symbol_id: "shared.id",
          name: "b",
          qualified_name: "b",
          kind: "function",
          line_start: 1,
          line_end: 1
        }],
        dependencies: [],
        diagnostics: []
      }
    ]
  }), /duplicate plugin symbol id/);
});
