import fs from "node:fs";
import path from "node:path";
import { openStore } from "./store.js";
import { expandQuery } from "../prefilter.js";
import { traverseGraph } from "./traversal.js";

function loadProjectAliases(repoRoot) {
  const file = path.join(repoRoot, ".context-query-aliases.json");
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid .context-query-aliases.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function aliasTermsFromExpansion(expansion, source) {
  const out = new Set();
  for (const entry of expansion.applied_aliases ?? []) {
    if (entry.source !== source) continue;
    for (const alias of entry.aliases ?? []) {
      const raw = String(alias).trim().toLowerCase();
      if (!raw) continue;
      out.add(raw);
      const compact = raw.replace(/[\s_.:/\\-]+/g, "");
      if (compact.length >= 2) out.add(compact);
    }
  }
  return [...out];
}

function textScore(text, terms, weight = 1) {
  const value = String(text ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!value.includes(term)) continue;
    score += weight;
    if (value.startsWith(term)) score += weight * 0.5;
  }
  return score;
}

function addFile(map, file, score, reason, symbol = null, channel = "misc") {
  if (!file) return;
  const current = map.get(file) ?? {
    path: file,
    score: 0,
    reasons: [],
    symbols: new Set(),
    channel_scores: Object.create(null)
  };
  current.channel_scores[channel] = Math.max(current.channel_scores[channel] ?? 0, score);
  current.score = Object.values(current.channel_scores).reduce((sum, value) => sum + Number(value), 0);
  if (reason && !current.reasons.includes(reason)) current.reasons.push(reason);
  if (symbol) current.symbols.add(symbol);
  map.set(file, current);
}

function fileScoreMultiplier(filePath, terms) {
  const normalized = String(filePath ?? "").replaceAll("\\", "/").toLowerCase();
  const dbIntent = terms.some((term) =>
    ["migration", "migrations", "schema", "database", "sql", "table", "数据库", "迁移", "表结构"].includes(term)
  );
  if (dbIntent) return 1;
  if (/(^|\/)migrations?\//.test(normalized)) {
    return /\.down\.sql$/.test(normalized) ? 0.12 : 0.25;
  }
  return 1;
}

const QUERY_GRAPH_FORWARD_TYPES = Object.freeze([
  "page_api",
  "api_request",
  "route_handler",
  "call",
  "db_read",
  "db_write"
]);

const QUERY_GRAPH_REVERSE_TYPES = Object.freeze([
  "page_api",
  "api_request",
  "route_handler",
  "call",
  "db_read",
  "db_write",
  "test_of"
]);

function graphNodeScore(direction, hop) {
  const base = direction === "forward" ? 10 : 8;
  return Math.max(2, base - Math.max(0, hop - 1) * 2);
}

function expandFromGraph(db, files, seedNodes) {
  const before = new Set(files.keys());
  let forwardSteps = 0;
  let reverseSteps = 0;
  const visitedSeeds = [];

  for (const seed of seedNodes.slice(0, 12)) {
    visitedSeeds.push(seed);
    for (const [direction, edgeTypes] of [
      ["forward", QUERY_GRAPH_FORWARD_TYPES],
      ["reverse", QUERY_GRAPH_REVERSE_TYPES]
    ]) {
      const traversal = traverseGraph(db, {
        startNodeIds: seed,
        direction,
        maxHops: 6,
        branchLimit: 12,
        nodeLimit: 96,
        minConfidence: "static",
        edgeTypes
      });

      if (direction === "forward") forwardSteps += traversal.steps.length;
      else reverseSteps += traversal.steps.length;

      const hopByNode = new Map([[seed, 0]]);
      const edgeTypeByNode = new Map();
      for (const step of traversal.steps) {
        const current = hopByNode.get(step.from_node_id) ?? Math.max(0, step.hop - 1);
        const next = Math.min(step.hop, current + 1);
        const previous = hopByNode.get(step.next_node_id);
        if (previous === undefined || next < previous) hopByNode.set(step.next_node_id, next);
        if (!edgeTypeByNode.has(step.next_node_id)) edgeTypeByNode.set(step.next_node_id, step.type);
      }

      for (const node of traversal.visited_nodes) {
        if (!node.file_path || node.node_id === seed) continue;
        const hop = hopByNode.get(node.node_id) ?? 1;
        const type = edgeTypeByNode.get(node.node_id) ?? "typed_edge";
        addFile(
          files,
          node.file_path,
          graphNodeScore(direction, hop),
          `graph_${direction}:${type}`,
          node.symbol_id ?? null,
          "typed_graph"
        );
      }
    }
  }

  const addedFilePaths = [...files.keys()].filter((file) => !before.has(file));
  return {
    seed_nodes: visitedSeeds,
    added_files: addedFilePaths.length,
    added_file_paths: addedFilePaths,
    forward_steps: forwardSteps,
    reverse_steps: reverseSteps
  };
}

function channelEntries(files, channel) {
  return [...files.values()]
    .filter((entry) => Number(entry.channel_scores?.[channel] ?? 0) > 0)
    .sort((a, b) =>
      Number(b.channel_scores[channel]) - Number(a.channel_scores[channel])
      || b.score - a.score
      || a.path.localeCompare(b.path)
    );
}

function symbolSeedsFromEntries(entries, limit) {
  const out = [];
  for (const entry of entries) {
    for (const symbolId of [...entry.symbols].sort()) {
      out.push(`symbol:${symbolId}`);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function buildGraphSeeds(files, matchedRouteNodes, matchedDbNodes, nonTestFiles) {
  const overall = [...files.values()]
    .filter((entry) => nonTestFiles.has(entry.path))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const nodes = [
    ...symbolSeedsFromEntries(channelEntries(files, "symbol"), 3),
    ...matchedRouteNodes.slice(0, 2),
    ...[...new Set(matchedDbNodes)].slice(0, 3),
    ...symbolSeedsFromEntries(channelEntries(files, "db"), 2),
    ...overall.slice(0, 2).map((entry) => `file:${entry.path}`)
  ];
  return [...new Set(nodes)].slice(0, 12);
}

function expandReverseImports(db, files, filePaths, nonTestFiles) {
  const before = new Set(files.keys());
  let steps = 0;
  const seeds = [...new Set(filePaths)]
    .filter((file) => nonTestFiles.has(file))
    .slice(0, 8);

  for (const file of seeds) {
    const seed = `file:${file}`;
    const traversal = traverseGraph(db, {
      startNodeIds: seed,
      direction: "reverse",
      maxHops: 1,
      branchLimit: 8,
      nodeLimit: 32,
      minConfidence: "static",
      edgeTypes: ["import"]
    });
    steps += traversal.steps.length;

    for (const node of traversal.visited_nodes) {
      if (!node.file_path || node.node_id === seed || !nonTestFiles.has(node.file_path)) continue;
      addFile(
        files,
        node.file_path,
        6,
        "graph_reverse:import",
        node.symbol_id ?? null,
        "typed_graph"
      );
    }
  }

  return {
    seed_files: seeds,
    steps,
    added_files: [...files.keys()].filter((file) => !before.has(file)).length
  };
}

function applyIntentPathBoost(files, builtinTerms) {
  if (builtinTerms.length === 0) return 0;
  let boosted = 0;
  for (const entry of [...files.values()]) {
    const score = Math.min(16, textScore(entry.path, builtinTerms, 8));
    if (score <= 0) continue;
    addFile(files, entry.path, score, "intent_path_match", null, "intent");
    boosted++;
  }
  return boosted;
}

export function queryContext({ repoRoot, task, indexDir = ".context-index", maxFiles = 12 }) {
  const dir = path.isAbsolute(indexDir) ? indexDir : path.join(repoRoot, indexDir);
  const { db } = openStore(dir);
  try {
    const expansion = expandQuery(task, loadProjectAliases(repoRoot));
    const terms = expansion.terms;
    const projectTerms = aliasTermsFromExpansion(expansion, "project");
    const builtinTerms = aliasTermsFromExpansion(expansion, "builtin");
    const files = new Map();
    const featureCandidates = [];
    const features = db.prepare("SELECT * FROM features").all();
    for (const feature of features) {
      let score = textScore(feature.name, terms, 12) + textScore(feature.description, terms, 8);
      const inv = db.prepare("SELECT text FROM feature_invariants WHERE feature_id=?").all(feature.feature_id).map((r)=>r.text);
      for (const text of inv) score += textScore(text, terms, 5);
      const steps = db.prepare("SELECT action,symbol_id,file_path FROM feature_steps WHERE feature_id=? ORDER BY step_order").all(feature.feature_id);
      for (const step of steps) score += textScore(step.action, terms, 5);
      if (score > 0) featureCandidates.push({ ...feature, score, invariants: inv, steps });
    }
    featureCandidates.sort((a,b)=>b.score-a.score);
    const topFeatures = featureCandidates.slice(0, 3);
    for (const feature of topFeatures) {
      for (const step of feature.steps) {
        if (step.symbol_id) {
          const symbol = db.prepare("SELECT * FROM symbols WHERE symbol_id=?").get(step.symbol_id);
          if (symbol) addFile(files, symbol.file_path, 24 + feature.score * 0.15, `feature:${feature.feature_id}`, symbol.symbol_id, "feature");
        } else if (step.file_path) addFile(files, step.file_path, 16, `feature:${feature.feature_id}`, null, "feature");
      }
    }

    const symbols = db.prepare("SELECT * FROM symbols").all();
    const rankedSymbols = [];
    for (const symbol of symbols) {
      const projectScore =
        textScore(symbol.name, projectTerms, 36) +
        textScore(symbol.qualified_name, projectTerms, 30) +
        textScore(symbol.file_path, projectTerms, 20) +
        textScore(symbol.description, projectTerms, 12);
      const genericScore =
        textScore(symbol.name, terms, 14) +
        textScore(symbol.qualified_name, terms, 12) +
        textScore(symbol.description, terms, 7) +
        textScore(symbol.signature, terms, 5) +
        textScore(symbol.file_path, terms, 6);
      const score = projectScore + genericScore;
      const eligible = projectTerms.length > 0 ? projectScore > 0 : score > 0;
      if (eligible) rankedSymbols.push({ ...symbol, score, project_score: projectScore });
    }
    rankedSymbols.sort((a,b)=>b.score-a.score);
    for (const symbol of rankedSymbols.slice(0, 20)) addFile(files, symbol.file_path, symbol.score, "symbol_match", symbol.symbol_id, "symbol");

    const matchedRouteNodes = [];
    const routes = db.prepare("SELECT * FROM routes").all();
    for (const route of routes) {
      const routeText = `${route.method} ${route.route_path}`;
      const projectScore = textScore(routeText, projectTerms, 24);
      const score = textScore(routeText, terms, 10) + projectScore;
      if (score > 0 && (projectTerms.length === 0 || projectScore > 0)) {
        addFile(files, route.file_path, score, `route:${route.method} ${route.route_path}`, route.symbol_id, "route");
        matchedRouteNodes.push(`route:${route.direction}:${route.method}:${route.route_path}`);
      }
    }
    const matchedDbNodes = [];
    const dbObjects = db.prepare("SELECT * FROM db_objects").all();
    for (const obj of dbObjects) {
      const dbText = `${obj.object_name} ${obj.operation}`;
      const projectScore = textScore(dbText, projectTerms, 18);
      const score = textScore(dbText, terms, 8) + projectScore;
      if (score > 0 && (projectTerms.length === 0 || projectScore > 0)) {
        addFile(files, obj.file_path, score, `db:${obj.object_name}`, obj.symbol_id, "db");
        matchedDbNodes.push(`db:${obj.object_type}:${obj.object_name}`);
      }
    }

    const fileRows = db.prepare("SELECT path,is_test FROM files WHERE is_test=0").all();
    for (const fileRow of fileRows) {
      const projectScore = textScore(fileRow.path, projectTerms, 18);
      const genericScore = projectTerms.length === 0 ? textScore(fileRow.path, terms, 2) : 0;
      const score = projectScore + genericScore;
      if (score > 0) addFile(files, fileRow.path, score, "path_match", null, "path");
    }

    const seedSymbols = new Set([...files.values()].flatMap((x)=>[...x.symbols]));
    const nonTestFiles = new Set(
      db.prepare("SELECT path FROM files WHERE is_test=0").all().map((row) => row.path)
    );
    const graphSeeds = buildGraphSeeds(files, matchedRouteNodes, matchedDbNodes, nonTestFiles);
    const graphExpansion = expandFromGraph(db, files, graphSeeds);

    const importCandidates = graphExpansion.added_file_paths
      .map((file) => files.get(file))
      .filter(Boolean)
      .sort((a, b) =>
        textScore(b.path, builtinTerms, 1) - textScore(a.path, builtinTerms, 1)
        || b.score - a.score
        || a.path.localeCompare(b.path)
      )
      .map((entry) => entry.path);
    const importExpansion = expandReverseImports(
      db,
      files,
      importCandidates,
      nonTestFiles
    );
    const intentBoostedFiles = applyIntentPathBoost(files, builtinTerms);

    for (const symbolId of [...seedSymbols].slice(0, 30)) {
      const edges = db.prepare(`SELECT d.*,s.file_path AS target_file FROM dependencies d LEFT JOIN symbols s ON s.symbol_id=d.resolved_symbol_id WHERE d.from_symbol_id=? OR d.resolved_symbol_id=?`).all(symbolId,symbolId);
      for (const edge of edges) {
        if (edge.from_symbol_id === symbolId && edge.target_file) addFile(files, edge.target_file, 5, `callee_of:${symbolId}`, edge.resolved_symbol_id, "graph");
        else if (edge.resolved_symbol_id === symbolId) addFile(files, edge.from_file, 4, `caller_of:${symbolId}`, edge.from_symbol_id, "graph");
      }
    }

    const preliminary = [...files.values()].sort((a,b)=>b.score-a.score);
    for (const candidate of preliminary.slice(0, 10)) {
      const tests = db.prepare("SELECT * FROM tests WHERE target_file=? OR target_symbol_id IN (SELECT symbol_id FROM symbols WHERE file_path=?)").all(candidate.path,candidate.path);
      for (const test of tests) addFile(files, test.test_file, 7, `test_for:${candidate.path}`, test.test_symbol_id, "test");
    }

    const rankedFiles = [...files.values()]
      .map((x)=>({
        ...x,
        raw_score: x.score,
        score: x.score * fileScoreMultiplier(x.path, terms),
        symbols:[...x.symbols],
        channel_scores: x.channel_scores
      }))
      .sort((a,b)=>b.score-a.score || a.path.localeCompare(b.path));
    const selected = rankedFiles.slice(0, Math.max(1,maxFiles));
    const selectedSet = new Set(selected.map((x)=>x.path));
    const relevantFeatures = topFeatures.map((feature)=>({ id:feature.feature_id,name:feature.name,description:feature.description,status:feature.status,needs_review:Boolean(feature.needs_review),score:Number(feature.score.toFixed(2)),invariants:feature.invariants }));
    const implementation = selected.filter((x)=>!db.prepare("SELECT is_test FROM files WHERE path=?").get(x.path)?.is_test);
    const selectedTests = selected.filter((x)=>db.prepare("SELECT is_test FROM files WHERE path=?").get(x.path)?.is_test);
    const mustRead = implementation.slice(0, Math.min(8, implementation.length));
    const maybeRead = implementation.slice(mustRead.length);
    const wantedSymbolIds = new Set(selected.flatMap((x)=>x.symbols));
    const symbolRows = db.prepare("SELECT * FROM symbols").all().filter((s)=>wantedSymbolIds.has(s.symbol_id) || selectedSet.has(s.file_path));
    const rankMap = new Map(rankedSymbols.map((s)=>[s.symbol_id,s.score]));
    const symbolDetails = symbolRows.slice(0,32).map((s)=>({ symbol_id:s.symbol_id,name:s.qualified_name,file:s.file_path,lines:[s.line_start,s.line_end],signature:s.signature,description:s.description,score:Number((rankMap.get(s.symbol_id) ?? 0).toFixed(2)) }));
    const tests = selectedTests.map((x)=>x.path);
    const coverage = {
      candidate_files: rankedFiles.length,
      selected_files: selected.length,
      exact_feature_hits: relevantFeatures.length,
      strong_symbol_hits: rankedSymbols.filter((s)=>s.score >= 20).length,
      status: rankedFiles.length === 0
        ? "insufficient"
        : (topFeatures.some((f)=>f.status !== "valid" || f.needs_review)
          ? "review_required"
          : ((rankedFiles.length > Math.max(60, maxFiles * 5) || rankedSymbols.filter((s)=>s.score >= 20).length > 250)
            ? "broad"
            : "sufficient"))
    };
    return {
      ok:true,
      task,
      terms,
      query_expansion: {
        applied_aliases: expansion.applied_aliases,
        project_terms: projectTerms,
        retrieval_mode: projectTerms.length > 0 ? "project_anchor" : "lexical",
        graph_seed_nodes: graphExpansion.seed_nodes
      },
      graph_expansion: {
        added_files: graphExpansion.added_files + importExpansion.added_files,
        forward_steps: graphExpansion.forward_steps,
        reverse_steps: graphExpansion.reverse_steps,
        import_reverse_steps: importExpansion.steps,
        import_seed_files: importExpansion.seed_files,
        intent_boosted_files: intentBoostedFiles
      },
      features: relevantFeatures,
      must_read: mustRead.map((x)=>({path:x.path,score:Number(x.score.toFixed(2)),reasons:x.reasons,symbols:x.symbols})),
      maybe_read: maybeRead.map((x)=>({path:x.path,score:Number(x.score.toFixed(2)),reasons:x.reasons,symbols:x.symbols})),
      symbols: symbolDetails,
      tests,
      coverage,
      semantic_refinement_recommended: ["insufficient", "broad"].includes(coverage.status)
    };
  } finally { db.close(); }
}
