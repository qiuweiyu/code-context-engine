import fs from "node:fs/promises";
import path from "node:path";
import { listTrackedSourceFiles, resolveGitRoot } from "../git.js";
import { isBlockedFile } from "../security.js";
import { sha256Text } from "./hash.js";
import { detectLanguage, isTestPath } from "./language.js";
import { normalizeRel } from "./utils.js";
import { openStore, transaction } from "./store.js";
import { PARSER_VERSION } from "./schema.js";
import { analyzeGoFiles } from "./go-runner.js";
import { analyzeScriptFile } from "./analyze-script.js";
import { extractDbObjects, extractRoutes } from "./analyze-common.js";
import { loadFeatureDefinitions, markFeaturesForFileChange, markFeaturesForSymbolChange, refreshFeatureStatus, syncFeatureDefinitions } from "./features.js";
import { exportIndex } from "./export.js";
import { rebuildDependencyEdges, rebuildRouteHandlerEdges } from "./edges.js";

async function readLocalSource(repoRoot, relPath) {
  const full = path.resolve(repoRoot, relPath);
  const rel = path.relative(repoRoot, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path traversal rejected");
  const stat = await fs.lstat(full);
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  if (stat.size > 4 * 1024 * 1024) return null;
  const buffer = await fs.readFile(full);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function insertAnalysis(db, relPath, language, hash, text, analysis, now) {
  const lineCount = text === "" ? 0 : text.split(/\r?\n/).length;
  db.prepare(`INSERT OR REPLACE INTO files(path,language,content_hash,line_count,parser_version,indexed_at,is_test) VALUES(?,?,?,?,?,?,?)`)
    .run(relPath, language, hash, lineCount, PARSER_VERSION, now, isTestPath(relPath) ? 1 : 0);

  const symbolStmt = db.prepare(`INSERT INTO symbols(symbol_id,file_path,language,name,qualified_name,kind,receiver,signature,params_json,returns_json,description,description_source,line_start,line_end,implementation_hash,semantic_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const symbol of analysis.symbols ?? []) {
    symbolStmt.run(symbol.symbol_id, relPath, language, symbol.name, symbol.qualified_name, symbol.kind, symbol.receiver ?? null, symbol.signature ?? "", JSON.stringify(symbol.params ?? []), JSON.stringify(symbol.returns ?? []), symbol.description ?? "", symbol.description_source ?? "derived", symbol.line_start ?? 1, symbol.line_end ?? 1, symbol.implementation_hash, symbol.semantic_hash);
  }

  const depStmt = db.prepare(`INSERT INTO dependencies(from_file,from_symbol_id,relation,to_ref,to_file,resolved_symbol_id) VALUES(?,?,?,?,?,?)`);
  for (const dep of analysis.dependencies ?? []) depStmt.run(relPath, dep.from_symbol_id ?? null, dep.relation, dep.to_ref, dep.to_file ?? null, null);

  const symbols = analysis.symbols ?? [];
  const routeStmt = db.prepare(`INSERT INTO routes(file_path,symbol_id,method,route_path,direction,line,handler_ref,handler_owner_type,handler_symbol_id) VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const route of extractRoutes(text, relPath, symbols)) {
    routeStmt.run(
      relPath,
      route.symbol_id,
      route.method,
      route.route_path,
      route.direction,
      route.line,
      route.handler_ref ?? null,
      route.handler_owner_type ?? null,
      null
    );
  }

  const dbStmt = db.prepare(`INSERT INTO db_objects(file_path,symbol_id,object_type,object_name,operation,line) VALUES(?,?,?,?,?,?)`);
  for (const obj of extractDbObjects(text, relPath, symbols)) dbStmt.run(relPath, obj.symbol_id, obj.object_type, obj.object_name, obj.operation, obj.line);
}

function resolveDependencies(db) {
  const symbols = db.prepare("SELECT symbol_id,name,qualified_name FROM symbols").all();
  const byQualified = new Map();
  const byName = new Map();
  for (const s of symbols) {
    if (!byQualified.has(s.qualified_name)) byQualified.set(s.qualified_name, []);
    byQualified.get(s.qualified_name).push(s.symbol_id);
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s.symbol_id);
  }
  const deps = db.prepare("SELECT id,to_ref FROM dependencies WHERE relation='calls'").all();
  const update = db.prepare("UPDATE dependencies SET resolved_symbol_id=? WHERE id=?");
  for (const dep of deps) {
    const raw = String(dep.to_ref ?? "");
    const tail = raw.split(".").pop();
    const exact = byQualified.get(raw) ?? [];
    const simple = byName.get(tail) ?? [];
    const resolved = exact.length === 1 ? exact[0] : (simple.length === 1 ? simple[0] : null);
    update.run(resolved, dep.id);
  }
}

function rebuildTestMappings(db) {
  db.prepare("DELETE FROM tests").run();
  const testFiles = db.prepare("SELECT path FROM files WHERE is_test=1").all().map((r)=>r.path);
  const allFiles = new Set(db.prepare("SELECT path FROM files").all().map((r)=>r.path));
  const insert = db.prepare(`INSERT INTO tests(test_file,test_symbol_id,target_file,target_symbol_id,confidence,reason) VALUES(?,?,?,?,?,?)`);
  for (const testFile of testFiles) {
    const candidates = [];
    const normalized = testFile.replace(/_test\.go$/, ".go").replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, ".$2");
    if (normalized !== testFile && allFiles.has(normalized)) candidates.push({ file: normalized, confidence: 0.98, reason: "filename_pair" });
    const deps = db.prepare(`SELECT DISTINCT resolved_symbol_id FROM dependencies WHERE from_file=? AND relation='calls' AND resolved_symbol_id IS NOT NULL`).all(testFile);
    for (const dep of deps) {
      const target = db.prepare("SELECT file_path FROM symbols WHERE symbol_id=?").get(dep.resolved_symbol_id);
      if (target && target.file_path !== testFile) candidates.push({ file: target.file_path, symbol: dep.resolved_symbol_id, confidence: 0.90, reason: "test_calls_symbol" });
    }
    const seen = new Set();
    for (const c of candidates) {
      const key = `${c.file}:${c.symbol ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      insert.run(testFile, null, c.file, c.symbol ?? null, c.confidence, c.reason);
    }
  }
}

function markOldFeatureRefs(db, filePath, oldSymbols, newSymbolMap, now) {
  const changedIds = [];
  for (const old of oldSymbols) {
    const current = newSymbolMap.get(old.symbol_id);
    if (!current || current.implementation_hash !== old.implementation_hash || current.semantic_hash !== old.semantic_hash) {
      changedIds.push(old.symbol_id);
      db.prepare(`INSERT INTO change_events(indexed_at,kind,file_path,symbol_id,old_hash,new_hash,detail) VALUES(?,?,?,?,?,?,?)`)
        .run(now, current ? "symbol_changed" : "symbol_removed", filePath, old.symbol_id, old.implementation_hash, current?.implementation_hash ?? null, current ? "implementation_or_semantics_changed" : "symbol_missing_after_reindex");
    }
  }
  for (const current of newSymbolMap.values()) {
    if (!oldSymbols.some((x)=>x.symbol_id === current.symbol_id)) db.prepare(`INSERT INTO change_events(indexed_at,kind,file_path,symbol_id,old_hash,new_hash,detail) VALUES(?,?,?,?,?,?,?)`)
      .run(now, "symbol_added", filePath, current.symbol_id, null, current.implementation_hash, "new_symbol");
  }
  markFeaturesForSymbolChange(db, changedIds);
}

export async function indexRepository({ repoRoot, indexDir = ".context-index", force = false } = {}) {
  const gitRoot = await resolveGitRoot(repoRoot);
  const outDir = path.isAbsolute(indexDir) ? indexDir : path.join(gitRoot, indexDir);
  const { db, dbPath } = openStore(outDir);
  const now = new Date().toISOString();
  try {
    const tracked = (await listTrackedSourceFiles(gitRoot)).map(normalizeRel).filter((p)=>!isBlockedFile(p) && !p.startsWith(".context-index/") && !p.startsWith(".context-features/"));
    const trackedSet = new Set(tracked);
    const existing = db.prepare("SELECT path,content_hash,parser_version FROM files").all();
    const existingMap = new Map(existing.map((r)=>[r.path,r]));
    const removed = existing.filter((r)=>!trackedSet.has(r.path)).map((r)=>r.path);
    let changed = 0, skipped = 0, unreadable = 0;
    const pending = [];

    for (const relPath of tracked) {
      const text = await readLocalSource(gitRoot, relPath);
      if (text === null) { unreadable++; continue; }
      const contentHash = sha256Text(text);
      const old = existingMap.get(relPath);
      if (!force && old?.content_hash === contentHash && old?.parser_version === PARSER_VERSION) { skipped++; continue; }
      pending.push({ relPath, text, contentHash, language: detectLanguage(relPath) });
    }

    const goResults = await analyzeGoFiles(gitRoot, pending.filter((x)=>x.language === "go").map((x)=>x.relPath));

    transaction(db, () => {
      for (const filePath of removed) {
        const oldSymbols = db.prepare("SELECT symbol_id,implementation_hash,semantic_hash FROM symbols WHERE file_path=?").all(filePath);
        markFeaturesForSymbolChange(db, oldSymbols.map((x)=>x.symbol_id), "referenced_file_removed");
        markFeaturesForFileChange(db, filePath, "referenced_file_removed");
        for (const old of oldSymbols) db.prepare(`INSERT INTO change_events(indexed_at,kind,file_path,symbol_id,old_hash,new_hash,detail) VALUES(?,?,?,?,?,?,?)`).run(now,"symbol_removed",filePath,old.symbol_id,old.implementation_hash,null,"file_removed");
        db.prepare("DELETE FROM files WHERE path=?").run(filePath);
      }

      for (const item of pending) {
        const oldSymbols = db.prepare("SELECT symbol_id,implementation_hash,semantic_hash FROM symbols WHERE file_path=?").all(item.relPath);
        markFeaturesForFileChange(db, item.relPath);
        db.prepare("DELETE FROM files WHERE path=?").run(item.relPath);
        let analysis = { symbols: [], dependencies: [] };
        if (item.language === "go") analysis = goResults.get(item.relPath) ?? analysis;
        else if (["typescript","javascript","vue"].includes(item.language)) analysis = analyzeScriptFile({ text: item.text, relPath: item.relPath, language: item.language, trackedSet });
        insertAnalysis(db, item.relPath, item.language, item.contentHash, item.text, analysis, now);
        const newSymbols = new Map((analysis.symbols ?? []).map((s)=>[s.symbol_id,s]));
        markOldFeatureRefs(db, item.relPath, oldSymbols, newSymbols, now);
        db.prepare(`INSERT INTO change_events(indexed_at,kind,file_path,symbol_id,old_hash,new_hash,detail) VALUES(?,?,?,?,?,?,?)`).run(now,"file_reindexed",item.relPath,null,existingMap.get(item.relPath)?.content_hash ?? null,item.contentHash,"file_content_or_parser_changed");
        changed++;
      }
      resolveDependencies(db);
      rebuildTestMappings(db);
      rebuildDependencyEdges(db);
      rebuildRouteHandlerEdges(db);
    });

    const definitions = await loadFeatureDefinitions(gitRoot);
    syncFeatureDefinitions(db, definitions, now);
    refreshFeatureStatus(db, now);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run("last_indexed_at", now);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run("repository_root", gitRoot);
    const manifest = await exportIndex(db, outDir);
    return { ok: true, repository: gitRoot, index_dir: outDir, database: dbPath, changed_files: changed, skipped_files: skipped, removed_files: removed.length, unreadable_files: unreadable, feature_definitions: definitions.length, manifest };
  } finally {
    db.close();
  }
}
