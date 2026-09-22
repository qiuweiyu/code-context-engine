import { EDGE_CONFIDENCE, EDGE_TYPES } from "./edges.js";

export const TRAVERSAL_EDGE_PRIORITY = Object.freeze([
  "api_request",
  "route_handler",
  "call",
  "db_read",
  "db_write",
  "page_api",
  "test_of",
  "import"
]);

const CONFIDENCE_RANK = new Map([
  ["unresolved", 0],
  ["inferred", 1],
  ["static", 2],
  ["exact", 3]
]);

const EDGE_PRIORITY_RANK = new Map(
  TRAVERSAL_EDGE_PRIORITY.map((type, index) => [type, index])
);

function asPositiveInteger(value, name, fallback, max) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return resolved;
}

function normalizeStartNodes(value) {
  const input = Array.isArray(value) ? value : [value];
  const nodes = [...new Set(
    input.map((item) => String(item ?? "").trim()).filter(Boolean)
  )].sort();
  if (nodes.length === 0) throw new Error("startNodeIds must contain at least one node");
  return nodes;
}

function normalizeEdgeTypes(value) {
  if (value == null) return [...EDGE_TYPES];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("edgeTypes must be a non-empty array");
  }
  const unique = [...new Set(value.map((item) => String(item)))];
  for (const type of unique) {
    if (!EDGE_TYPES.includes(type)) throw new Error(`unsupported edge type: ${type}`);
  }
  return unique;
}

function edgePriority(edge) {
  return EDGE_PRIORITY_RANK.get(edge.type) ?? TRAVERSAL_EDGE_PRIORITY.length;
}

function compareEdges(a, b) {
  return edgePriority(a) - edgePriority(b)
    || (CONFIDENCE_RANK.get(b.confidence) ?? -1) - (CONFIDENCE_RANK.get(a.confidence) ?? -1)
    || String(a.edge_id).localeCompare(String(b.edge_id));
}

function parseEvidence(value) {
  try {
    return JSON.parse(value);
  } catch {
    return { type: "invalid_evidence_json" };
  }
}

function rowToEdge(row) {
  return {
    edge_id: row.edge_id,
    from_node_id: row.from_node_id,
    to_node_id: row.to_node_id,
    type: row.type,
    confidence: row.confidence,
    evidence: parseEvidence(row.evidence_json),
    source_kind: row.source_kind,
    source_id: row.source_id
  };
}

function incidentEdges(db, nodeId, direction, edgeTypes) {
  const field = direction === "forward" ? "from_node_id" : "to_node_id";
  const rows = db.prepare(
    `SELECT edge_id,from_node_id,to_node_id,type,confidence,evidence_json,source_kind,source_id
     FROM edges WHERE ${field}=?`
  ).all(nodeId);
  const allowed = new Set(edgeTypes);
  return rows.map(rowToEdge).filter((edge) => allowed.has(edge.type)).sort(compareEdges);
}

function otherNode(edge, direction) {
  return direction === "forward" ? edge.to_node_id : edge.from_node_id;
}

function edgeSummary(edge, direction, hop, nextNodeId = null) {
  return {
    hop,
    direction,
    edge_id: edge.edge_id,
    type: edge.type,
    confidence: edge.confidence,
    from_node_id: edge.from_node_id,
    to_node_id: edge.to_node_id,
    next_node_id: nextNodeId ?? otherNode(edge, direction),
    evidence: edge.evidence
  };
}

function parseRouteNode(nodeId) {
  const rest = nodeId.slice("route:".length);
  const directionEnd = rest.indexOf(":");
  if (directionEnd < 0) return null;
  const routeDirection = rest.slice(0, directionEnd);
  const afterDirection = rest.slice(directionEnd + 1);
  const methodEnd = afterDirection.indexOf(":");
  if (methodEnd < 0) return null;
  return {
    direction: routeDirection,
    method: afterDirection.slice(0, methodEnd),
    route_path: afterDirection.slice(methodEnd + 1)
  };
}

function describeNode(db, nodeId) {
  if (nodeId.startsWith("symbol:")) {
    const symbolId = nodeId.slice("symbol:".length);
    const row = db.prepare(
      `SELECT symbol_id,file_path,language,name,qualified_name,kind,line_start,line_end
       FROM symbols WHERE symbol_id=?`
    ).get(symbolId);
    return row
      ? { node_id: nodeId, kind: "symbol", ...row }
      : { node_id: nodeId, kind: "symbol", symbol_id: symbolId };
  }

  if (nodeId.startsWith("file:")) {
    return {
      node_id: nodeId,
      kind: "file",
      file_path: nodeId.slice("file:".length)
    };
  }

  if (nodeId.startsWith("route:")) {
    const parsed = parseRouteNode(nodeId);
    if (!parsed) return { node_id: nodeId, kind: "route" };
    const row = db.prepare(
      `SELECT id,file_path,symbol_id,method,route_path,direction,line,handler_symbol_id
       FROM routes
       WHERE direction=? AND method=? AND route_path=?
       ORDER BY id LIMIT 1`
    ).get(parsed.direction, parsed.method, parsed.route_path);
    return row
      ? { node_id: nodeId, kind: "route", ...row }
      : { node_id: nodeId, kind: "route", ...parsed };
  }

  if (nodeId.startsWith("ref:")) {
    return {
      node_id: nodeId,
      kind: "ref",
      ref: nodeId.slice("ref:".length)
    };
  }

  return { node_id: nodeId, kind: "unknown" };
}

export function traverseGraph(db, {
  startNodeIds,
  direction = "forward",
  maxHops = 3,
  branchLimit = 8,
  nodeLimit = 128,
  minConfidence = "static",
  edgeTypes = null
} = {}) {
  if (!db?.prepare) throw new Error("db must be an open sqlite database");
  if (!["forward", "reverse"].includes(direction)) {
    throw new Error("direction must be forward or reverse");
  }
  if (!EDGE_CONFIDENCE.includes(minConfidence) || minConfidence === "unresolved") {
    throw new Error("minConfidence must be exact, static, or inferred");
  }

  const starts = normalizeStartNodes(startNodeIds);
  const hopLimit = asPositiveInteger(maxHops, "maxHops", 3, 4);
  const widthLimit = asPositiveInteger(branchLimit, "branchLimit", 8, 100);
  const totalNodeLimit = asPositiveInteger(nodeLimit, "nodeLimit", 128, 1000);
  if (starts.length > totalNodeLimit) {
    throw new Error("startNodeIds exceed nodeLimit");
  }
  const types = normalizeEdgeTypes(edgeTypes);
  const minRank = CONFIDENCE_RANK.get(minConfidence);

  const queue = starts.map((nodeId) => ({ node_id: nodeId, hop: 0 }));
  const visited = new Set(starts);
  const visitedOrder = [...starts];
  const steps = [];
  const frontier = [];
  const unresolvedLinks = [];
  let cycleSkips = 0;
  let omittedUnresolved = 0;
  let omittedFrontier = 0;

  const pushFrontier = (item) => {
    if (frontier.length < totalNodeLimit) frontier.push(item);
    else omittedFrontier++;
  };

  const pushUnresolved = (item) => {
    if (unresolvedLinks.length < totalNodeLimit) unresolvedLinks.push(item);
    else omittedUnresolved++;
  };

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    const edges = incidentEdges(db, current.node_id, direction, types);

    const unresolved = edges.filter((edge) => edge.confidence === "unresolved");
    for (const edge of unresolved.slice(0, widthLimit)) {
      pushUnresolved({
        node_id: current.node_id,
        ...edgeSummary(edge, direction, current.hop + 1)
      });
    }
    omittedUnresolved += Math.max(0, unresolved.length - widthLimit);

    const eligible = [];
    for (const edge of edges) {
      if (edge.confidence === "unresolved") continue;
      const rank = CONFIDENCE_RANK.get(edge.confidence) ?? -1;
      if (rank < minRank) {
        pushFrontier({
          reason: "confidence_threshold",
          node_id: current.node_id,
          ...edgeSummary(edge, direction, current.hop + 1)
        });
        continue;
      }
      eligible.push(edge);
    }

    if (current.hop >= hopLimit) {
      for (const edge of eligible.slice(0, widthLimit)) {
        pushFrontier({
          reason: "max_hops",
          node_id: current.node_id,
          ...edgeSummary(edge, direction, current.hop + 1)
        });
      }
      if (eligible.length > widthLimit) {
        pushFrontier({
          reason: "branch_limit",
          node_id: current.node_id,
          hop: current.hop + 1,
          omitted_edges: eligible.length - widthLimit
        });
      }
      continue;
    }

    const selected = eligible.slice(0, widthLimit);
    if (eligible.length > widthLimit) {
      pushFrontier({
        reason: "branch_limit",
        node_id: current.node_id,
        hop: current.hop + 1,
        omitted_edges: eligible.length - widthLimit
      });
    }

    for (const edge of selected) {
      const nextNodeId = otherNode(edge, direction);
      if (visited.has(nextNodeId)) {
        cycleSkips++;
        continue;
      }
      if (visited.size >= totalNodeLimit) {
        pushFrontier({
          reason: "node_limit",
          node_id: current.node_id,
          ...edgeSummary(edge, direction, current.hop + 1, nextNodeId)
        });
        continue;
      }
      const hop = current.hop + 1;
      visited.add(nextNodeId);
      visitedOrder.push(nextNodeId);
      steps.push(edgeSummary(edge, direction, hop, nextNodeId));
      queue.push({ node_id: nextNodeId, hop });
    }
  }

  return {
    start_nodes: starts,
    direction,
    limits: {
      max_hops: hopLimit,
      branch_limit: widthLimit,
      node_limit: totalNodeLimit,
      min_confidence: minConfidence,
      edge_types: types
    },
    visited_nodes: visitedOrder.map((nodeId) => describeNode(db, nodeId)),
    steps,
    frontier,
    unresolved_links: unresolvedLinks,
    stats: {
      visited_nodes: visitedOrder.length,
      steps: steps.length,
      frontier: frontier.length,
      unresolved_links: unresolvedLinks.length,
      omitted_unresolved: omittedUnresolved,
      omitted_frontier: omittedFrontier,
      cycle_skips: cycleSkips
    }
  };
}
