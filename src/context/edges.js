export const EDGE_TYPES = Object.freeze([
  "call",
  "import",
  "route_handler",
  "api_request",
  "db_read",
  "db_write",
  "test_of",
  "page_api"
]);

export const EDGE_CONFIDENCE = Object.freeze([
  "exact",
  "static",
  "inferred",
  "unresolved"
]);

const DEPENDENCY_EDGE_TYPES = new Map([
  ["calls", "call"],
  ["imports", "import"]
]);

const DB_READ_OPERATIONS = new Set(["select", "join"]);
const DB_WRITE_OPERATIONS = new Set(["insert", "update", "delete", "create", "alter"]);

function nodeId(kind, value) {
  return `${kind}:${String(value)}`;
}

export function dependencyToTypedEdge(dep) {
  const type = DEPENDENCY_EDGE_TYPES.get(dep.relation);
  if (!type) return null;

  const fromNodeId = dep.from_symbol_id
    ? nodeId("symbol", dep.from_symbol_id)
    : nodeId("file", dep.from_file);

  let toNodeId;
  let confidence = "unresolved";
  if (dep.resolved_symbol_id) {
    toNodeId = nodeId("symbol", dep.resolved_symbol_id);
    confidence = "static";
  } else if (dep.to_file) {
    toNodeId = nodeId("file", dep.to_file);
    confidence = "static";
  } else {
    toNodeId = nodeId("ref", `${type}:${dep.to_ref}`);
  }

  let metadata = {};
  try {
    metadata = dep.metadata_json ? JSON.parse(dep.metadata_json) : {};
  } catch {
    metadata = {};
  }

  const evidence = {
    type: confidence === "unresolved" ? "unresolved_reference" : "static_resolution",
    source: "dependencies",
    source_id: dep.id,
    relation: dep.relation,
    from_file: dep.from_file,
    to_ref: dep.to_ref,
    ...(metadata.resolution ? { resolution: metadata.resolution } : {}),
    ...(metadata.call_kind ? { call_kind: metadata.call_kind } : {}),
    ...(metadata.receiver_type ? { receiver_type: metadata.receiver_type } : {}),
    ...(metadata.receiver_field ? { receiver_field: metadata.receiver_field } : {}),
    ...(metadata.field_type ? { field_type: metadata.field_type } : {}),
    ...(metadata.field_kind ? { field_kind: metadata.field_kind } : {}),
    ...(metadata.resolved_receiver ? { resolved_receiver: metadata.resolved_receiver } : {}),
    ...(metadata.resolved_package ? { resolved_package: metadata.resolved_package } : {}),
    ...(Number.isInteger(metadata.candidate_count) ? { candidate_count: metadata.candidate_count } : {})
  };

  return {
    edge_id: `dependency:${dep.id}`,
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    type,
    confidence,
    evidence,
    source_kind: "dependency",
    source_id: dep.id
  };
}

export function rebuildDependencyEdges(db) {
  db.prepare("DELETE FROM edges WHERE source_kind='dependency'").run();
  const deps = db.prepare("SELECT * FROM dependencies ORDER BY id").all();
  const insert = db.prepare(`INSERT INTO edges(edge_id,from_node_id,to_node_id,type,confidence,evidence_json,source_kind,source_id)
    VALUES(?,?,?,?,?,?,?,?)`);

  for (const dep of deps) {
    const edge = dependencyToTypedEdge(dep);
    if (!edge) continue;
    insert.run(
      edge.edge_id,
      edge.from_node_id,
      edge.to_node_id,
      edge.type,
      edge.confidence,
      JSON.stringify(edge.evidence),
      edge.source_kind,
      edge.source_id
    );
  }
}


export function dbObjectToTypedEdge(obj) {
  const operation = String(obj.operation ?? "").toLowerCase();
  const type = DB_READ_OPERATIONS.has(operation)
    ? "db_read"
    : (DB_WRITE_OPERATIONS.has(operation) ? "db_write" : null);
  if (!type) return null;

  const fromNodeId = obj.symbol_id
    ? nodeId("symbol", obj.symbol_id)
    : nodeId("file", obj.file_path);
  const toNodeId = `db:${obj.object_type}:${obj.object_name}`;

  return {
    edge_id: `db_object:${obj.id}`,
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    type,
    confidence: "static",
    evidence: {
      type: "static_resolution",
      source: "db_objects",
      source_id: obj.id,
      file: obj.file_path,
      line: obj.line,
      object_type: obj.object_type,
      object_name: obj.object_name,
      operation,
      resolution: "sql_object_operation"
    },
    source_kind: "db_object",
    source_id: obj.id
  };
}

export function rebuildDbObjectEdges(db) {
  db.prepare("DELETE FROM edges WHERE source_kind='db_object'").run();
  const objects = db.prepare("SELECT * FROM db_objects ORDER BY id").all();
  const insert = db.prepare(`INSERT INTO edges(edge_id,from_node_id,to_node_id,type,confidence,evidence_json,source_kind,source_id)
    VALUES(?,?,?,?,?,?,?,?)`);

  for (const obj of objects) {
    const edge = dbObjectToTypedEdge(obj);
    if (!edge) continue;
    insert.run(
      edge.edge_id,
      edge.from_node_id,
      edge.to_node_id,
      edge.type,
      edge.confidence,
      JSON.stringify(edge.evidence),
      edge.source_kind,
      edge.source_id
    );
  }
}

export function listTypedEdges(db) {
  return db.prepare("SELECT * FROM edges ORDER BY edge_id").all().map((row) => ({
    ...row,
    evidence: JSON.parse(row.evidence_json),
    evidence_json: undefined
  }));
}


function typeBase(value) {
  const raw = String(value ?? "").trim().replace(/^\(+|\)+$/g, "").replace(/^\*+/, "");
  const noGeneric = raw.replace(/\[.*\]$/, "");
  return noGeneric.split(".").pop() ?? noGeneric;
}

function qualifiedBase(value) {
  return String(value ?? "").replace(/^\*+/, "");
}

function routeHandlerResolution(db, route, symbolsByName, symbolsByQualified) {
  const raw = String(route.handler_ref ?? "").trim();
  if (!raw) {
    return { symbol_id: null, confidence: "unresolved", resolution: "handler_reference_missing" };
  }

  const exact = symbolsByQualified.get(qualifiedBase(raw)) ?? [];
  if (exact.length === 1) {
    return { symbol_id: exact[0].symbol_id, confidence: "static", resolution: "qualified_name" };
  }

  const parts = raw.split(".");
  const member = parts.at(-1);
  if (parts.length > 1 && route.symbol_id) {
    const registration = db.prepare("SELECT params_json,receiver FROM symbols WHERE symbol_id=?").get(route.symbol_id);
    if (route.handler_owner_type) {
      const ownerType = typeBase(route.handler_owner_type);
      const candidates = (symbolsByName.get(member) ?? []).filter(
        (symbol) => typeBase(symbol.receiver) === ownerType
      );
      if (candidates.length === 1) {
        return { symbol_id: candidates[0].symbol_id, confidence: "static", resolution: "method_receiver_type" };
      }
    }
    if (registration?.params_json) {
      const params = JSON.parse(registration.params_json);
      const receiverVariable = parts[0];
      const parameter = params.find((item) => item?.name === receiverVariable);
      if (parameter?.type) {
        const receiverType = typeBase(parameter.type);
        const candidates = (symbolsByName.get(member) ?? []).filter(
          (symbol) => typeBase(symbol.receiver) === receiverType
        );
        if (candidates.length === 1) {
          return { symbol_id: candidates[0].symbol_id, confidence: "static", resolution: "receiver_parameter_type" };
        }
      }
    }
    return { symbol_id: null, confidence: "unresolved", resolution: "receiver_not_resolved" };
  }

  if (parts.length === 1) {
    const candidates = symbolsByName.get(member) ?? [];
    if (candidates.length === 1) {
      return { symbol_id: candidates[0].symbol_id, confidence: "static", resolution: "unique_symbol_name" };
    }
  }

  return { symbol_id: null, confidence: "unresolved", resolution: "handler_not_unique" };
}

export function rebuildRouteHandlerEdges(db) {
  db.prepare("DELETE FROM edges WHERE source_kind='route'").run();

  const symbols = db.prepare("SELECT symbol_id,name,qualified_name,receiver FROM symbols").all();
  const symbolsByName = new Map();
  const symbolsByQualified = new Map();
  for (const symbol of symbols) {
    if (!symbolsByName.has(symbol.name)) symbolsByName.set(symbol.name, []);
    symbolsByName.get(symbol.name).push(symbol);

    const qualified = qualifiedBase(symbol.qualified_name);
    if (!symbolsByQualified.has(qualified)) symbolsByQualified.set(qualified, []);
    symbolsByQualified.get(qualified).push(symbol);
  }

  const routes = db.prepare("SELECT * FROM routes WHERE direction='server' ORDER BY id").all();
  const update = db.prepare("UPDATE routes SET handler_symbol_id=? WHERE id=?");
  const insert = db.prepare(`INSERT INTO edges(edge_id,from_node_id,to_node_id,type,confidence,evidence_json,source_kind,source_id)
    VALUES(?,?,?,?,?,?,?,?)`);

  for (const route of routes) {
    const resolved = routeHandlerResolution(db, route, symbolsByName, symbolsByQualified);
    update.run(resolved.symbol_id, route.id);

    const routeNode = `route:server:${route.method}:${route.route_path}`;
    const targetNode = resolved.symbol_id
      ? `symbol:${resolved.symbol_id}`
      : `ref:route_handler:${route.handler_ref || route.id}`;
    const evidence = {
      type: resolved.symbol_id ? "static_resolution" : "unresolved_reference",
      source: "routes",
      source_id: route.id,
      file: route.file_path,
      line: route.line,
      method: route.method,
      route_path: route.route_path,
      handler_ref: route.handler_ref ?? null,
      resolution: resolved.resolution
    };

    insert.run(
      `route:${route.id}`,
      routeNode,
      targetNode,
      "route_handler",
      resolved.confidence,
      JSON.stringify(evidence),
      "route",
      route.id
    );
  }
}


function routePathShape(routePath) {
  return String(routePath ?? "")
    .split("#", 1)[0]
    .split("?", 1)[0]
    .replace(/\{[^/{}]+\}/g, "{}");
}

export function rebuildApiRequestEdges(db) {
  db.prepare("DELETE FROM edges WHERE source_kind='client_route'").run();

  const serverRoutes = db.prepare(
    "SELECT id,method,route_path FROM routes WHERE direction='server' ORDER BY id"
  ).all();
  const clientRoutes = db.prepare(
    "SELECT * FROM routes WHERE direction='client' ORDER BY id"
  ).all();
  const insert = db.prepare(`INSERT INTO edges(edge_id,from_node_id,to_node_id,type,confidence,evidence_json,source_kind,source_id)
    VALUES(?,?,?,?,?,?,?,?)`);

  for (const client of clientRoutes) {
    const method = String(client.method ?? "ANY").toUpperCase();
    const clientShape = routePathShape(client.route_path);
    let candidates = [];
    let resolution = "route_not_found";

    if (method === "ANY") {
      candidates = serverRoutes.filter((route) => routePathShape(route.route_path) === clientShape);
      resolution = "method_unresolved";
    } else {
      candidates = serverRoutes.filter(
        (route) =>
          String(route.method).toUpperCase() === method
          && routePathShape(route.route_path) === clientShape
      );
      resolution = candidates.length === 1
        ? (candidates[0].route_path === client.route_path ? "method_exact_path" : "method_path_shape")
        : (candidates.length > 1 ? "route_not_unique" : "route_not_found");
    }

    const resolved = method !== "ANY" && candidates.length === 1 ? candidates[0] : null;
    const fromNode = client.symbol_id
      ? `symbol:${client.symbol_id}`
      : `file:${client.file_path}`;
    const toNode = resolved
      ? `route:server:${resolved.method}:${resolved.route_path}`
      : `ref:api_request:${method}:${client.route_path}`;

    const evidence = {
      type: resolved ? "static_resolution" : "unresolved_reference",
      source: "routes",
      source_id: client.id,
      file: client.file_path,
      line: client.line,
      method,
      client_route_path: client.route_path,
      server_route_id: resolved?.id ?? null,
      server_route_path: resolved?.route_path ?? null,
      resolution
    };

    insert.run(
      `api_request:${client.id}`,
      fromNode,
      toNode,
      "api_request",
      resolved ? "static" : "unresolved",
      JSON.stringify(evidence),
      "client_route",
      client.id
    );
  }
}
