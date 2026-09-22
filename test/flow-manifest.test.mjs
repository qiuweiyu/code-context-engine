import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/context/schema.js";
import { buildFlowManifest, FLOW_MANIFEST_VERSION } from "../src/context/flow-manifest.js";

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','6')").run();
  db.prepare("INSERT INTO meta(key,value) VALUES('last_indexed_at','2026-09-22T00:00:00.000Z')").run();

  const file = db.prepare(
    "INSERT INTO files(path,language,content_hash,line_count,parser_version,indexed_at,is_test) VALUES(?,?,?,?,?,?,0)"
  );
  for (const [filePath, language] of [
    ["web/api/items.ts", "typescript"],
    ["backend/api.go", "go"],
    ["backend/service.go", "go"]
  ]) {
    file.run(filePath, language, filePath, 10, "0.2.2", "2026-09-22T00:00:00.000Z");
  }

  const symbol = db.prepare(
    `INSERT INTO symbols(
      symbol_id,file_path,language,name,qualified_name,kind,receiver,signature,
      params_json,returns_json,description,description_source,line_start,line_end,
      implementation_hash,semantic_hash
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  for (const item of [
    ["typescript:web/api/items.ts::getItem", "web/api/items.ts", "typescript", "getItem", "getItem", "function", null, 2, 4],
    ["typescript:web/api/items.ts::getItemPage", "web/api/items.ts", "typescript", "getItemPage", "getItemPage", "function", null, 6, 8],
    ["go:backend/api.go::*API.Get", "backend/api.go", "go", "Get", "*API.Get", "method", "*API", 2, 4],
    ["go:backend/service.go::*Service.Get", "backend/service.go", "go", "Get", "*Service.Get", "method", "*Service", 2, 4]
  ]) {
    symbol.run(
      item[0], item[1], item[2], item[3], item[4], item[5], item[6], "",
      "[]", "[]", "", "derived", item[7], item[8], item[0], item[0]
    );
  }

  db.prepare(
    `INSERT INTO routes(
      id,file_path,symbol_id,method,route_path,direction,line,
      handler_ref,handler_owner_type,handler_symbol_id
    ) VALUES(1,?,?,?,?,?,?,?,?,?)`
  ).run(
    "backend/api.go",
    "go:backend/api.go::*API.Get",
    "GET",
    "/api/items/{item_id}",
    "server",
    5,
    "api.Get",
    "*API",
    "go:backend/api.go::*API.Get"
  );

  return db;
}

function addEdge(db, {
  id,
  from,
  to,
  type,
  confidence = "static",
  evidence = {}
}) {
  db.prepare(
    `INSERT INTO edges(
      edge_id,from_node_id,to_node_id,type,confidence,evidence_json,source_kind,source_id
    ) VALUES(?,?,?,?,?,?,?,?)`
  ).run(
    id,
    from,
    to,
    type,
    confidence,
    JSON.stringify(evidence),
    "fixture",
    Number(id.replace(/\D/g, "") || 0)
  );
}

function seedRequestFlow(db) {
  const frontendA = "symbol:typescript:web/api/items.ts::getItem";
  const frontendB = "symbol:typescript:web/api/items.ts::getItemPage";
  const route = "route:server:GET:/api/items/{item_id}";
  const handler = "symbol:go:backend/api.go::*API.Get";
  const service = "symbol:go:backend/service.go::*Service.Get";

  addEdge(db, {
    id: "e1",
    from: frontendA,
    to: route,
    type: "api_request",
    evidence: {
      type: "static_resolution",
      source: "routes",
      source_id: 10,
      file: "web/api/items.ts",
      line: 3,
      method: "GET",
      client_route_path: "/api/items/{param}",
      server_route_path: "/api/items/{item_id}",
      resolution: "method_path_shape",
      raw_source: "must not leak"
    }
  });
  addEdge(db, {
    id: "e2",
    from: frontendB,
    to: route,
    type: "api_request",
    evidence: {
      type: "static_resolution",
      source: "routes",
      source_id: 11,
      file: "web/api/items.ts",
      line: 7,
      method: "GET",
      resolution: "method_path_shape"
    }
  });
  addEdge(db, {
    id: "e3",
    from: route,
    to: handler,
    type: "route_handler",
    evidence: {
      type: "static_resolution",
      source: "routes",
      source_id: 1,
      file: "backend/api.go",
      line: 5,
      method: "GET",
      route_path: "/api/items/{item_id}",
      resolution: "method_receiver_type"
    }
  });
  addEdge(db, {
    id: "e4",
    from: handler,
    to: service,
    type: "call",
    evidence: {
      type: "static_resolution",
      source: "dependencies",
      source_id: 20,
      relation: "calls",
      from_file: "backend/api.go",
      to_ref: "Service.Get"
    }
  });

  return { frontendA, frontendB, route, handler, service };
}

test("flow manifest is deterministic and compact for a forward request flow", () => {
  const db = makeDb();
  try {
    const { frontendA, route, handler } = seedRequestFlow(db);
    const options = {
      startNodeIds: frontendA,
      direction: "forward",
      maxHops: 2,
      edgeTypes: ["api_request", "route_handler"]
    };

    const first = buildFlowManifest(db, options);
    const second = buildFlowManifest(db, options);

    assert.deepEqual(first, second);
    assert.equal(first.manifest_version, FLOW_MANIFEST_VERSION);
    assert.equal(first.schema_version, 6);
    assert.deepEqual(first.parser_versions, [{ parser_version: "0.2.2", files: 3 }]);
    assert.deepEqual(first.summary, {
      flow_count: 1,
      complete: 1,
      partial: 0,
      total_nodes: 3,
      total_steps: 2,
      unresolved_links: 0
    });

    const flow = first.flows[0];
    assert.equal(flow.status, "complete");
    assert.equal(flow.entry.node_id, frontendA);
    assert.deepEqual(flow.steps.map((step) => step.type), ["api_request", "route_handler"]);
    assert.equal(flow.steps[0].next_node_id, route);
    assert.equal(flow.steps[1].next_node_id, handler);
    assert.equal(flow.steps[0].evidence.resolution, "method_path_shape");
    assert.equal("raw_source" in flow.steps[0].evidence, false);
    assert.equal(JSON.stringify(first).includes("must not leak"), false);
    assert.deepEqual(flow.files, ["backend/api.go", "web/api/items.ts"]);
  } finally {
    db.close();
  }
});

test("reverse manifest preserves one-to-many callers", () => {
  const db = makeDb();
  try {
    const { frontendA, frontendB, handler } = seedRequestFlow(db);

    const manifest = buildFlowManifest(db, {
      startNodeIds: handler,
      direction: "reverse",
      maxHops: 2,
      edgeTypes: ["route_handler", "api_request"]
    });

    const flow = manifest.flows[0];
    assert.equal(flow.status, "complete");
    assert.deepEqual(
      flow.steps
        .filter((step) => step.type === "api_request")
        .map((step) => step.next_node_id)
        .sort(),
      [frontendA, frontendB].sort()
    );
    assert.equal(flow.nodes.find((node) => node.node_id === handler)?.kind, "symbol");
    assert.equal(flow.nodes.find((node) => node.node_id === handler)?.symbol_kind, "method");
  } finally {
    db.close();
  }
});

test("unresolved links produce a partial flow without exposing unapproved evidence", () => {
  const db = makeDb();
  try {
    const { handler } = seedRequestFlow(db);
    addEdge(db, {
      id: "e5",
      from: handler,
      to: "ref:call:dynamicTarget",
      type: "call",
      confidence: "unresolved",
      evidence: {
        type: "unresolved_reference",
        source: "dependencies",
        source_id: 21,
        from_file: "backend/api.go",
        to_ref: "dynamicTarget",
        source_text: "private source body"
      }
    });

    const manifest = buildFlowManifest(db, {
      startNodeIds: handler,
      direction: "forward",
      maxHops: 1,
      edgeTypes: ["call"]
    });

    const flow = manifest.flows[0];
    assert.equal(flow.status, "partial");
    assert.equal(flow.unresolved_links.length, 1);
    assert.equal(flow.unresolved_links[0].evidence.to_ref, "dynamicTarget");
    assert.equal(JSON.stringify(manifest).includes("private source body"), false);
    assert.equal(manifest.summary.partial, 1);
  } finally {
    db.close();
  }
});

test("multiple entry points are normalized into deterministic flow order", () => {
  const db = makeDb();
  try {
    const { frontendA, frontendB } = seedRequestFlow(db);

    const manifest = buildFlowManifest(db, {
      startNodeIds: [frontendB, frontendA, frontendB],
      maxHops: 1,
      edgeTypes: ["api_request"]
    });

    assert.deepEqual(
      manifest.flows.map((flow) => flow.entry.node_id),
      [frontendA, frontendB].sort()
    );
    assert.equal(manifest.summary.flow_count, 2);
  } finally {
    db.close();
  }
});


test("flow manifest enforces a global entry-point bound", () => {
  const db = makeDb();
  try {
    const starts = Array.from(
      { length: 33 },
      (_, index) => `symbol:typescript:web/api/items.ts::entry${index}`
    );

    assert.throws(
      () => buildFlowManifest(db, { startNodeIds: starts }),
      /startNodeIds must contain at most 32 nodes/
    );
  } finally {
    db.close();
  }
});
