import fs from "node:fs/promises";
import path from "node:path";
import { hashObject } from "../context/hash.js";
import { listTypedEdges } from "../context/edges.js";

export const PUBLIC_INDEX_FORMAT = "cce-public-index";
export const PUBLIC_INDEX_VERSION = "1.0.0";

const PUBLIC_EVIDENCE_KEYS = Object.freeze([
  "type", "relation", "resolution", "from_file", "to_ref",
  "call_kind", "receiver_type", "receiver_field", "field_type", "field_kind",
  "resolved_receiver", "resolved_package", "target_package", "target_name",
  "selection_kind", "go_types_checked", "module_ref", "module_file",
  "binding_kind", "local_binding", "imported_name", "candidate_count",
  "file", "line", "method", "route_path", "handler_ref",
  "handler_owner_type", "entry_kind", "entry_name", "registration",
  "client_method", "client_path", "server_method", "server_path",
  "object_type", "object_name", "operation",
  "test_file", "target_file", "reason"
]);

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function pickEvidence(value) {
  const input = value && typeof value === "object" ? value : {};
  const out = {};
  for (const key of PUBLIC_EVIDENCE_KEYS) {
    if (input[key] !== undefined && input[key] !== null) out[key] = input[key];
  }
  return out;
}

function routeNodeId(row) {
  return `route:${row.direction}:${row.method}:${row.route_path}`;
}

function dbNodeId(row) {
  return `db:${row.object_type}:${row.object_name}`;
}

function referenceKind(nodeId) {
  if (nodeId.startsWith("ref:")) return "reference";
  if (nodeId.startsWith("route:")) return "route";
  if (nodeId.startsWith("db:")) return "data_object";
  if (nodeId.startsWith("entry:")) return "entry";
  if (nodeId.startsWith("symbol:")) return "symbol";
  if (nodeId.startsWith("file:")) return "document";
  return "unknown";
}

function addNode(nodes, node) {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function addObservation(node, observation) {
  if (!Array.isArray(node.observations)) node.observations = [];
  const key = JSON.stringify(observation);
  if (!node.observations.some((item) => JSON.stringify(item) === key)) {
    node.observations.push(observation);
  }
}

function buildPublicNodes(db, edges) {
  const nodes = new Map();

  for (const row of db.prepare("SELECT * FROM files ORDER BY path").all()) {
    addNode(nodes, {
      id: `file:${row.path}`,
      kind: "document",
      path: row.path,
      language: row.language,
      line_count: row.line_count,
      is_test: Boolean(row.is_test),
      package_name: row.package_name ?? null
    });
  }

  for (const row of db.prepare(
    "SELECT * FROM symbols ORDER BY file_path,line_start,symbol_id"
  ).all()) {
    addNode(nodes, {
      id: `symbol:${row.symbol_id}`,
      kind: "symbol",
      symbol_id: row.symbol_id,
      document: row.file_path,
      language: row.language,
      name: row.name,
      qualified_name: row.qualified_name,
      symbol_kind: row.kind,
      receiver: row.receiver ?? null,
      signature: row.signature,
      params: parseJson(row.params_json, []),
      returns: parseJson(row.returns_json, []),
      description: row.description,
      description_source: row.description_source,
      line_start: row.line_start,
      line_end: row.line_end,
      implementation_hash: row.implementation_hash,
      semantic_hash: row.semantic_hash
    });
  }

  for (const row of db.prepare(
    "SELECT * FROM entry_points ORDER BY file_path,line,id"
  ).all()) {
    addNode(nodes, {
      id: row.node_id,
      kind: "entry",
      document: row.file_path,
      entry_kind: row.entry_kind,
      entry_name: row.entry_name,
      line: row.line,
      handler_ref: row.handler_ref ?? null,
      handler_symbol_id: row.handler_symbol_id ?? null,
      metadata: parseJson(row.metadata_json, {})
    });
  }

  for (const row of db.prepare(
    "SELECT * FROM routes ORDER BY direction,method,route_path,file_path,line,id"
  ).all()) {
    const id = routeNodeId(row);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: "route",
        direction: row.direction,
        method: row.method,
        route_path: row.route_path,
        observations: []
      });
    }
    addObservation(nodes.get(id), {
      document: row.file_path,
      line: row.line,
      symbol_id: row.symbol_id ?? null,
      handler_ref: row.handler_ref ?? null,
      handler_symbol_id: row.handler_symbol_id ?? null
    });
  }

  for (const row of db.prepare(
    "SELECT * FROM db_objects ORDER BY object_type,object_name,file_path,line,id"
  ).all()) {
    const id = dbNodeId(row);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: "data_object",
        object_type: row.object_type,
        object_name: row.object_name,
        observations: []
      });
    }
    addObservation(nodes.get(id), {
      document: row.file_path,
      line: row.line,
      symbol_id: row.symbol_id ?? null,
      operation: row.operation
    });
  }

  for (const edge of edges) {
    for (const nodeId of [edge.from, edge.to]) {
      if (!nodes.has(nodeId)) {
        addNode(nodes, {
          id: nodeId,
          kind: referenceKind(nodeId)
        });
      }
    }
  }

  return [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function buildPublicEdges(db) {
  const dedup = new Map();
  for (const edge of listTypedEdges(db)) {
    const evidence = pickEvidence(edge.evidence);
    const stable = {
      type: edge.type,
      from: edge.from_node_id,
      to: edge.to_node_id,
      confidence: edge.confidence,
      evidence
    };
    const id = "edge:" + hashObject(stable).slice(0, 24);
    if (!dedup.has(id)) dedup.set(id, { id, ...stable });
  }
  return [...dedup.values()].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
}

async function writeJsonl(filePath, records) {
  const body = records.map((record) => JSON.stringify(record)).join("\n")
    + (records.length ? "\n" : "");
  await fs.writeFile(filePath, body, "utf8");
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function publicV1Directory(indexDir) {
  return path.join(indexDir, "public", "v1");
}

export async function exportPublicIndexV1(db, indexDir) {
  const outputDir = publicV1Directory(indexDir);
  await fs.mkdir(outputDir, { recursive: true });

  const edges = buildPublicEdges(db);
  const nodes = buildPublicNodes(db, edges);
  const indexedAt = db.prepare(
    "SELECT value FROM meta WHERE key='last_indexed_at'"
  ).get()?.value ?? null;
  const internalSchemaVersion = Number(db.prepare(
    "SELECT value FROM meta WHERE key='schema_version'"
  ).get()?.value ?? 0);

  const manifest = {
    format: PUBLIC_INDEX_FORMAT,
    version: PUBLIC_INDEX_VERSION,
    compatibility: {
      major: 1,
      policy: "additive-fields-allowed"
    },
    indexed_at: indexedAt,
    internal_schema_version: internalSchemaVersion,
    files: {
      nodes: "nodes.jsonl",
      edges: "edges.jsonl"
    },
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      documents: nodes.filter((node) => node.kind === "document").length,
      symbols: nodes.filter((node) => node.kind === "symbol").length,
      entries: nodes.filter((node) => node.kind === "entry").length
    }
  };

  await Promise.all([
    writeJsonl(path.join(outputDir, "nodes.jsonl"), nodes),
    writeJsonl(path.join(outputDir, "edges.jsonl"), edges),
    fs.writeFile(
      path.join(outputDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8"
    )
  ]);
  return manifest;
}

export function validatePublicManifestV1(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("public index manifest must be an object");
  }
  if (manifest.format !== PUBLIC_INDEX_FORMAT) {
    throw new Error("unsupported public index format");
  }
  if (typeof manifest.version !== "string"
      || !/^1(?:\.|$)/.test(manifest.version)) {
    throw new Error("unsupported public index major version");
  }
  if (!manifest.files || manifest.files.nodes !== "nodes.jsonl"
      || manifest.files.edges !== "edges.jsonl") {
    throw new Error("public index v1 file map is invalid");
  }
  return manifest;
}

export function validatePublicNodeV1(node) {
  if (!node || typeof node !== "object"
      || typeof node.id !== "string"
      || typeof node.kind !== "string") {
    throw new Error("invalid public index node");
  }
  return node;
}

export function validatePublicEdgeV1(edge) {
  if (!edge || typeof edge !== "object"
      || typeof edge.id !== "string"
      || typeof edge.type !== "string"
      || typeof edge.from !== "string"
      || typeof edge.to !== "string"
      || typeof edge.confidence !== "string") {
    throw new Error("invalid public index edge");
  }
  return edge;
}

export async function readPublicIndexV1(indexDir) {
  const dir = publicV1Directory(indexDir);
  const manifest = validatePublicManifestV1(JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf8")
  ));
  const nodes = (await readJsonl(path.join(dir, manifest.files.nodes)))
    .map(validatePublicNodeV1);
  const edges = (await readJsonl(path.join(dir, manifest.files.edges)))
    .map(validatePublicEdgeV1);
  return { manifest, nodes, edges };
}
