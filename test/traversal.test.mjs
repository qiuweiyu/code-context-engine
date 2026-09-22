import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/context/schema.js";
import { traverseGraph } from "../src/context/traversal.js";

function graphDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);

  const file = db.prepare(
    "INSERT INTO files(path,language,content_hash,line_count,parser_version,indexed_at,is_test) VALUES(?,?,?,?,?,?,0)"
  );
  for (const [path, language] of [
    ["web/api/items.ts", "typescript"],
    ["backend/api.go", "go"],
    ["backend/service.go", "go"],
    ["noise.ts", "typescript"]
  ]) {
    file.run(path, language, path, 1, "0.2.2", "2026-09-22T00:00:00.000Z");
  }

  const symbol = db.prepare(
    `INSERT INTO symbols(
      symbol_id,file_path,language,name,qualified_name,kind,receiver,signature,
      params_json,returns_json,description,description_source,line_start,line_end,
      implementation_hash,semantic_hash
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const item of [
    ["typescript:web/api/items.ts::getItem", "web/api/items.ts", "typescript", "getItem", "getItem", "function", null],
    ["go:backend/api.go::*API.Get", "backend/api.go", "go", "Get", "*API.Get", "method", "*API"],
    ["go:backend/service.go::*Service.Get", "backend/service.go", "go", "Get", "*Service.Get", "method", "*Service"],
    ["go:backend/service.go::*Service.Other", "backend/service.go", "go", "Other", "*Service.Other", "method", "*Service"]
  ]) {
    symbol.run(
      item[0], item[1], item[2], item[3], item[4], item[5], item[6], "",
      "[]", "[]", "", "derived", 1, 1, item[0], item[0]
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
    1,
    "api.Get",
    "*API",
    "go:backend/api.go::*API.Get"
  );

  return db;
}

function addEdge(db, {
  edgeId,
  from,
  to,
  type,
  confidence = "static",
  sourceId
}) {
  db.prepare(
    `INSERT INTO edges(
      edge_id,from_node_id,to_node_id,type,confidence,evidence_json,source_kind,source_id
    ) VALUES(?,?,?,?,?,?,?,?)`
  ).run(
    edgeId,
    from,
    to,
    type,
    confidence,
    JSON.stringify({ source: "fixture", edge_id: edgeId }),
    "fixture",
    sourceId
  );
}

test("bounded forward traversal follows deterministic edge priority", () => {
  const db = graphDb();
  try {
    const frontend = "symbol:typescript:web/api/items.ts::getItem";
    const route = "route:server:GET:/api/items/{item_id}";
    const handler = "symbol:go:backend/api.go::*API.Get";
    const service = "symbol:go:backend/service.go::*Service.Get";

    addEdge(db, {
      edgeId: "z-import",
      from: frontend,
      to: "file:noise.ts",
      type: "import",
      sourceId: 1
    });
    addEdge(db, {
      edgeId: "a-api",
      from: frontend,
      to: route,
      type: "api_request",
      sourceId: 2
    });
    addEdge(db, {
      edgeId: "b-handler",
      from: route,
      to: handler,
      type: "route_handler",
      sourceId: 3
    });
    addEdge(db, {
      edgeId: "c-call",
      from: handler,
      to: service,
      type: "call",
      sourceId: 4
    });

    const result = traverseGraph(db, {
      startNodeIds: frontend,
      direction: "forward",
      maxHops: 3,
      branchLimit: 1
    });

    assert.deepEqual(result.steps.map((step) => step.type), [
      "api_request",
      "route_handler",
      "call"
    ]);
    assert.equal(result.steps.every((step) => step.confidence === "static"), true);
    assert.equal(result.visited_nodes.length, 4);
    const handlerNode = result.visited_nodes.find((node) => node.node_id === handler);
    assert.equal(handlerNode?.file_path, "backend/api.go");
    assert.equal(handlerNode?.kind, "symbol");
    assert.equal(handlerNode?.symbol_kind, "method");
    assert.ok(result.frontier.some(
      (item) => item.reason === "branch_limit" && item.node_id === frontend
    ));
  } finally {
    db.close();
  }
});

test("reverse traversal walks callers across route and API request edges", () => {
  const db = graphDb();
  try {
    const frontend = "symbol:typescript:web/api/items.ts::getItem";
    const route = "route:server:GET:/api/items/{item_id}";
    const handler = "symbol:go:backend/api.go::*API.Get";
    const service = "symbol:go:backend/service.go::*Service.Get";

    addEdge(db, {
      edgeId: "api",
      from: frontend,
      to: route,
      type: "api_request",
      sourceId: 11
    });
    addEdge(db, {
      edgeId: "handler",
      from: route,
      to: handler,
      type: "route_handler",
      sourceId: 12
    });
    addEdge(db, {
      edgeId: "call",
      from: handler,
      to: service,
      type: "call",
      sourceId: 13
    });

    const result = traverseGraph(db, {
      startNodeIds: service,
      direction: "reverse",
      maxHops: 3
    });

    assert.deepEqual(result.steps.map((step) => step.type), [
      "call",
      "route_handler",
      "api_request"
    ]);
    assert.equal(result.steps.at(-1).next_node_id, frontend);
    assert.equal(result.direction, "reverse");
  } finally {
    db.close();
  }
});

test("confidence threshold blocks inferred edges and never traverses unresolved edges", () => {
  const db = graphDb();
  try {
    const start = "symbol:typescript:web/api/items.ts::getItem";
    const inferredTarget = "symbol:go:backend/service.go::*Service.Other";

    addEdge(db, {
      edgeId: "inferred",
      from: start,
      to: inferredTarget,
      type: "call",
      confidence: "inferred",
      sourceId: 21
    });
    addEdge(db, {
      edgeId: "unresolved",
      from: start,
      to: "ref:call:dynamicTarget",
      type: "call",
      confidence: "unresolved",
      sourceId: 22
    });

    const strict = traverseGraph(db, {
      startNodeIds: start,
      minConfidence: "static"
    });
    assert.equal(strict.steps.length, 0);
    assert.equal(strict.unresolved_links.length, 1);
    assert.ok(strict.frontier.some((item) => item.reason === "confidence_threshold"));

    const permissive = traverseGraph(db, {
      startNodeIds: start,
      minConfidence: "inferred"
    });
    assert.equal(permissive.steps.length, 1);
    assert.equal(permissive.steps[0].confidence, "inferred");
    assert.equal(permissive.unresolved_links.length, 1);
    assert.equal(permissive.visited_nodes.some((node) => node.kind === "ref"), false);
  } finally {
    db.close();
  }
});

test("visited node set prevents traversal cycles", () => {
  const db = graphDb();
  try {
    const a = "symbol:go:backend/service.go::*Service.Get";
    const b = "symbol:go:backend/service.go::*Service.Other";

    addEdge(db, {
      edgeId: "a-to-b",
      from: a,
      to: b,
      type: "call",
      sourceId: 31
    });
    addEdge(db, {
      edgeId: "b-to-a",
      from: b,
      to: a,
      type: "call",
      sourceId: 32
    });

    const result = traverseGraph(db, {
      startNodeIds: a,
      maxHops: 6
    });

    assert.equal(result.steps.length, 1);
    assert.equal(result.visited_nodes.length, 2);
    assert.equal(result.stats.cycle_skips, 1);
  } finally {
    db.close();
  }
});

test("traversal enforces hard hop bound", () => {
  const db = graphDb();
  try {
    assert.throws(
      () => traverseGraph(db, {
        startNodeIds: "symbol:go:backend/service.go::*Service.Get",
        maxHops: 7
      }),
      /maxHops must be an integer between 1 and 6/
    );
  } finally {
    db.close();
  }
});


test("global node limit keeps traversal compact", () => {
  const db = graphDb();
  try {
    const start = "symbol:typescript:web/api/items.ts::getItem";
    addEdge(db, {
      edgeId: "node-limit",
      from: start,
      to: "symbol:go:backend/api.go::*API.Get",
      type: "api_request",
      sourceId: 41
    });

    const result = traverseGraph(db, {
      startNodeIds: start,
      nodeLimit: 1
    });

    assert.equal(result.visited_nodes.length, 1);
    assert.equal(result.steps.length, 0);
    assert.ok(result.frontier.some((item) => item.reason === "node_limit"));
  } finally {
    db.close();
  }
});
