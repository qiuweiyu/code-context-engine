import fs from "node:fs";
import path from "node:path";
import { openStore } from "./store.js";
import { expandQuery } from "../prefilter.js";

function loadProjectAliases(repoRoot) {
  const file = path.join(repoRoot, ".context-query-aliases.json");
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid .context-query-aliases.json: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function addFile(map, file, score, reason, symbol = null) {
  if (!file) return;
  const current = map.get(file) ?? { path: file, score: 0, reasons: [], symbols: new Set() };
  current.score += score;
  if (reason && !current.reasons.includes(reason)) current.reasons.push(reason);
  if (symbol) current.symbols.add(symbol);
  map.set(file, current);
}

export function queryContext({ repoRoot, task, indexDir = ".context-index", maxFiles = 12 }) {
  const dir = path.isAbsolute(indexDir) ? indexDir : path.join(repoRoot, indexDir);
  const { db } = openStore(dir);
  try {
    const expansion = expandQuery(task, loadProjectAliases(repoRoot));
    const terms = expansion.terms;
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
          if (symbol) addFile(files, symbol.file_path, 24 + feature.score * 0.15, `feature:${feature.feature_id}`, symbol.symbol_id);
        } else if (step.file_path) addFile(files, step.file_path, 16, `feature:${feature.feature_id}`);
      }
    }

    const symbols = db.prepare("SELECT * FROM symbols").all();
    const rankedSymbols = [];
    for (const symbol of symbols) {
      const score = textScore(symbol.name, terms, 14) + textScore(symbol.qualified_name, terms, 12) + textScore(symbol.description, terms, 7) + textScore(symbol.signature, terms, 5) + textScore(symbol.file_path, terms, 6);
      if (score > 0) rankedSymbols.push({ ...symbol, score });
    }
    rankedSymbols.sort((a,b)=>b.score-a.score);
    for (const symbol of rankedSymbols.slice(0, 20)) addFile(files, symbol.file_path, symbol.score, "symbol_match", symbol.symbol_id);

    const routes = db.prepare("SELECT * FROM routes").all();
    for (const route of routes) {
      const score = textScore(`${route.method} ${route.route_path}`, terms, 10);
      if (score > 0) addFile(files, route.file_path, score, `route:${route.method} ${route.route_path}`, route.symbol_id);
    }
    const dbObjects = db.prepare("SELECT * FROM db_objects").all();
    for (const obj of dbObjects) {
      const score = textScore(`${obj.object_name} ${obj.operation}`, terms, 8);
      if (score > 0) addFile(files, obj.file_path, score, `db:${obj.object_name}`, obj.symbol_id);
    }

    const seedSymbols = new Set([...files.values()].flatMap((x)=>[...x.symbols]));
    for (const symbolId of [...seedSymbols].slice(0, 30)) {
      const edges = db.prepare(`SELECT d.*,s.file_path AS target_file FROM dependencies d LEFT JOIN symbols s ON s.symbol_id=d.resolved_symbol_id WHERE d.from_symbol_id=? OR d.resolved_symbol_id=?`).all(symbolId,symbolId);
      for (const edge of edges) {
        if (edge.from_symbol_id === symbolId && edge.target_file) addFile(files, edge.target_file, 5, `callee_of:${symbolId}`, edge.resolved_symbol_id);
        else if (edge.resolved_symbol_id === symbolId) addFile(files, edge.from_file, 4, `caller_of:${symbolId}`, edge.from_symbol_id);
      }
    }

    const preliminary = [...files.values()].sort((a,b)=>b.score-a.score);
    for (const candidate of preliminary.slice(0, 10)) {
      const tests = db.prepare("SELECT * FROM tests WHERE target_file=? OR target_symbol_id IN (SELECT symbol_id FROM symbols WHERE file_path=?)").all(candidate.path,candidate.path);
      for (const test of tests) addFile(files, test.test_file, 7, `test_for:${candidate.path}`, test.test_symbol_id);
    }

    const rankedFiles = [...files.values()].map((x)=>({ ...x, symbols:[...x.symbols] })).sort((a,b)=>b.score-a.score || a.path.localeCompare(b.path));
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
      status: rankedFiles.length === 0 ? "insufficient" : (topFeatures.some((f)=>f.status !== "valid" || f.needs_review) ? "review_required" : "sufficient")
    };
    return {
      ok:true,
      task,
      terms,
      query_expansion: { applied_aliases: expansion.applied_aliases },
      features: relevantFeatures,
      must_read: mustRead.map((x)=>({path:x.path,score:Number(x.score.toFixed(2)),reasons:x.reasons,symbols:x.symbols})),
      maybe_read: maybeRead.map((x)=>({path:x.path,score:Number(x.score.toFixed(2)),reasons:x.reasons,symbols:x.symbols})),
      symbols: symbolDetails,
      tests,
      coverage,
      semantic_refinement_recommended: rankedFiles.length > 60 || coverage.status === "insufficient"
    };
  } finally { db.close(); }
}
