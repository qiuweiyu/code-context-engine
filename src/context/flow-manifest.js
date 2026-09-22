import { traverseGraph } from "./traversal.js";

export const FLOW_MANIFEST_VERSION = 1;

const EVIDENCE_KEYS = Object.freeze([
  "type",
  "source",
  "source_id",
  "file",
  "line",
  "method",
  "route_path",
  "client_route_path",
  "server_route_path",
  "handler_ref",
  "resolution",
  "relation",
  "from_file",
  "to_ref"
]);

function compactEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return {};
  const out = {};
  for (const key of EVIDENCE_KEYS) {
    if (evidence[key] !== undefined && evidence[key] !== null) {
      out[key] = evidence[key];
    }
  }
  return out;
}

function compactNode(node) {
  const base = {
    node_id: node.node_id,
    kind: node.kind
  };

  if (node.kind === "symbol") {
    return {
      ...base,
      symbol_id: node.symbol_id ?? null,
      symbol_kind: node.symbol_kind ?? null,
      language: node.language ?? null,
      name: node.name ?? null,
      qualified_name: node.qualified_name ?? null,
      file_path: node.file_path ?? null,
      line_start: node.line_start ?? null,
      line_end: node.line_end ?? null
    };
  }

  if (node.kind === "route") {
    return {
      ...base,
      method: node.method ?? null,
      route_path: node.route_path ?? null,
      direction: node.direction ?? null,
      file_path: node.file_path ?? null,
      line: node.line ?? null,
      handler_symbol_id: node.handler_symbol_id ?? null
    };
  }

  if (node.kind === "file") {
    return {
      ...base,
      file_path: node.file_path ?? null
    };
  }

  if (node.kind === "ref") {
    return {
      ...base,
      ref: node.ref ?? null
    };
  }

  return base;
}

function compactStep(step) {
  return {
    hop: step.hop,
    direction: step.direction,
    edge_id: step.edge_id,
    type: step.type,
    confidence: step.confidence,
    from_node_id: step.from_node_id,
    to_node_id: step.to_node_id,
    next_node_id: step.next_node_id,
    evidence: compactEvidence(step.evidence)
  };
}

function compactBoundaryItem(item) {
  const out = {
    reason: item.reason ?? null,
    node_id: item.node_id ?? null,
    hop: item.hop ?? null
  };

  if (item.edge_id) {
    out.edge_id = item.edge_id;
    out.type = item.type;
    out.confidence = item.confidence;
    out.from_node_id = item.from_node_id;
    out.to_node_id = item.to_node_id;
    out.next_node_id = item.next_node_id;
    out.evidence = compactEvidence(item.evidence);
  }

  if (item.omitted_edges !== undefined) {
    out.omitted_edges = item.omitted_edges;
  }

  return out;
}

function collectFiles(nodes, steps) {
  const files = new Set();

  for (const node of nodes) {
    if (node.file_path) files.add(node.file_path);
  }

  for (const step of steps) {
    const evidence = step.evidence ?? {};
    if (evidence.file) files.add(evidence.file);
    if (evidence.from_file) files.add(evidence.from_file);
  }

  return [...files].sort();
}

function parserVersions(db) {
  return db.prepare(
    "SELECT parser_version,COUNT(*) AS files FROM files GROUP BY parser_version ORDER BY parser_version"
  ).all().map((row) => ({
    parser_version: row.parser_version,
    files: row.files
  }));
}

function buildSingleFlow(db, startNodeId, options) {
  const traversal = traverseGraph(db, {
    ...options,
    startNodeIds: startNodeId
  });

  const nodes = traversal.visited_nodes.map(compactNode);
  const steps = traversal.steps.map(compactStep);
  const frontier = traversal.frontier.map(compactBoundaryItem);
  const unresolvedLinks = traversal.unresolved_links.map(compactBoundaryItem);
  const status = frontier.length === 0 && unresolvedLinks.length === 0
    ? "complete"
    : "partial";

  return {
    entry: nodes.find((node) => node.node_id === startNodeId)
      ?? { node_id: startNodeId, kind: "unknown" },
    status,
    direction: traversal.direction,
    limits: traversal.limits,
    nodes,
    steps,
    files: collectFiles(nodes, steps),
    frontier,
    unresolved_links: unresolvedLinks,
    stats: traversal.stats
  };
}

export function buildFlowManifest(db, {
  startNodeIds,
  direction = "forward",
  maxHops = 3,
  branchLimit = 8,
  nodeLimit = 128,
  minConfidence = "static",
  edgeTypes = null
} = {}) {
  if (!db?.prepare) throw new Error("db must be an open sqlite database");

  const starts = [...new Set(
    (Array.isArray(startNodeIds) ? startNodeIds : [startNodeIds])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  )].sort();

  if (starts.length === 0) {
    throw new Error("startNodeIds must contain at least one node");
  }

  const flows = starts.map((startNodeId) => buildSingleFlow(db, startNodeId, {
    direction,
    maxHops,
    branchLimit,
    nodeLimit,
    minConfidence,
    edgeTypes
  }));

  return {
    ok: true,
    manifest_version: FLOW_MANIFEST_VERSION,
    schema_version: Number(
      db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value ?? 0
    ),
    indexed_at:
      db.prepare("SELECT value FROM meta WHERE key='last_indexed_at'").get()?.value ?? null,
    parser_versions: parserVersions(db),
    summary: {
      flow_count: flows.length,
      complete: flows.filter((flow) => flow.status === "complete").length,
      partial: flows.filter((flow) => flow.status === "partial").length,
      total_nodes: flows.reduce((sum, flow) => sum + flow.stats.visited_nodes, 0),
      total_steps: flows.reduce((sum, flow) => sum + flow.stats.steps, 0),
      unresolved_links: flows.reduce((sum, flow) => sum + flow.stats.unresolved_links, 0)
    },
    flows
  };
}
