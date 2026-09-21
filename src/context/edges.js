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

  const evidence = {
    type: confidence === "unresolved" ? "unresolved_reference" : "static_resolution",
    source: "dependencies",
    source_id: dep.id,
    relation: dep.relation,
    from_file: dep.from_file,
    to_ref: dep.to_ref
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

export function listTypedEdges(db) {
  return db.prepare("SELECT * FROM edges ORDER BY edge_id").all().map((row) => ({
    ...row,
    evidence: JSON.parse(row.evidence_json),
    evidence_json: undefined
  }));
}
