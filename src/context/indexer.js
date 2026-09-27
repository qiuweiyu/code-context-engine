import fs from "node:fs/promises";
import path from "node:path";
import { listTrackedSourceFiles, resolveGitRoot } from "../git.js";
import { isBlockedFile } from "../security.js";
import { sha256Text } from "./hash.js";
import { detectLanguage, isTestPath } from "./language.js";
import { normalizeRel } from "./utils.js";
import { openStore, transaction } from "./store.js";
import { DEFAULT_ANALYZERS, analyzePendingFiles, parserVersionFor } from "./analyzers.js";
import { loadFeatureDefinitions, markFeaturesForFileChange, markFeaturesForSymbolChange, refreshFeatureStatus, syncFeatureDefinitions } from "./features.js";
import { exportIndex } from "./export.js";
import { rebuildApiRequestEdges, rebuildDbObjectEdges, rebuildDependencyEdges, rebuildPageApiEdges, rebuildRouteHandlerEdges, rebuildTestEdges } from "./edges.js";

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
  db.prepare(`INSERT OR REPLACE INTO files(path,language,content_hash,line_count,parser_version,indexed_at,is_test,package_name) VALUES(?,?,?,?,?,?,?,?)`)
    .run(
      relPath,
      language,
      hash,
      lineCount,
      analysis.parser_version,
      now,
      isTestPath(relPath) ? 1 : 0,
      language === "go" ? (analysis.package ?? null) : null
    );

  const symbolStmt = db.prepare(`INSERT INTO symbols(symbol_id,file_path,language,name,qualified_name,kind,receiver,signature,params_json,returns_json,description,description_source,line_start,line_end,implementation_hash,semantic_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const symbol of analysis.symbols ?? []) {
    symbolStmt.run(symbol.symbol_id, relPath, language, symbol.name, symbol.qualified_name, symbol.kind, symbol.receiver ?? null, symbol.signature ?? "", JSON.stringify(symbol.params ?? []), JSON.stringify(symbol.returns ?? []), symbol.description ?? "", symbol.description_source ?? "derived", symbol.line_start ?? 1, symbol.line_end ?? 1, symbol.implementation_hash, symbol.semantic_hash);
  }

  const depStmt = db.prepare(`INSERT INTO dependencies(from_file,from_symbol_id,relation,to_ref,to_file,resolved_symbol_id,metadata_json) VALUES(?,?,?,?,?,?,?)`);
  for (const dep of analysis.dependencies ?? []) {
    depStmt.run(
      relPath,
      dep.from_symbol_id ?? null,
      dep.relation,
      dep.to_ref,
      dep.to_file ?? null,
      dep.resolved_symbol_id ?? null,
      JSON.stringify(dep.metadata ?? {})
    );
  }

  const symbols = analysis.symbols ?? [];
  const routeStmt = db.prepare(`INSERT INTO routes(file_path,symbol_id,method,route_path,direction,line,handler_ref,handler_owner_type,handler_symbol_id) VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const route of analysis.routes) {
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
  for (const obj of analysis.dbObjects) dbStmt.run(relPath, obj.symbol_id, obj.object_type, obj.object_name, obj.operation, obj.line);
}

function normalizeGoType(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function goTypeBase(value) {
  let raw = String(value ?? "").trim();
  while (raw.startsWith("(") && raw.endsWith(")")) raw = raw.slice(1, -1).trim();
  raw = raw.replace(/^\*+/, "");
  const generic = raw.indexOf("[");
  if (generic >= 0) raw = raw.slice(0, generic);
  return raw.split(".").pop() ?? raw;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function symbolShape(symbol) {
  return {
    params: parseJson(symbol.params_json, []).map((item) => normalizeGoType(item?.type)),
    returns: parseJson(symbol.returns_json, []).map((item) => normalizeGoType(item?.type))
  };
}

function sameTypeList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeGoTypeForPackage(value, packageName) {
  const normalized = normalizeGoType(value);
  const pkg = String(packageName ?? "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pkg)) return normalized;
  return normalized.replace(new RegExp(`\\b${pkg}\\.`, "g"), "");
}

function methodMatchesShape(symbol, shape) {
  const actual = symbolShape(symbol);
  const expectedParams = (shape?.params ?? [])
    .map((value) => normalizeGoTypeForPackage(value, symbol.package_name));
  const expectedReturns = (shape?.returns ?? [])
    .map((value) => normalizeGoTypeForPackage(value, symbol.package_name));
  const actualParams = actual.params
    .map((value) => normalizeGoTypeForPackage(value, symbol.package_name));
  const actualReturns = actual.returns
    .map((value) => normalizeGoTypeForPackage(value, symbol.package_name));
  return sameTypeList(actualParams, expectedParams) && sameTypeList(actualReturns, expectedReturns);
}

function callCandidateInScope(dep, candidate) {
  if (!dep?.from_language || candidate?.language !== dep.from_language) return false;

  if (dep.from_language === "go") {
    const fromDir = path.posix.dirname(String(dep.from_file).replaceAll("\\", "/"));
    const targetDir = path.posix.dirname(String(candidate.file_path).replaceAll("\\", "/"));
    return fromDir === targetDir
      && String(candidate.package_name ?? "") === String(dep.from_package_name ?? "");
  }

  return candidate.file_path === dep.from_file;
}

function buildVueImportBindingIndex(db) {
  const index = new Map();
  const rows = db.prepare(
    "SELECT id,from_file,to_file,to_ref,metadata_json FROM dependencies WHERE relation='imports' AND to_file IS NOT NULL ORDER BY id"
  ).all();
  for (const row of rows) {
    const metadata = parseJson(row.metadata_json, {});
    const bindings = Array.isArray(metadata.import_bindings)
      ? metadata.import_bindings
      : [];
    for (const binding of bindings) {
      const local = String(binding?.local ?? "");
      if (!local) continue;
      if (!index.has(row.from_file)) index.set(row.from_file, new Map());
      const byLocal = index.get(row.from_file);
      if (!byLocal.has(local)) byLocal.set(local, []);
      byLocal.get(local).push({
        import_id: row.id,
        module_ref: row.to_ref,
        module_file: row.to_file,
        kind: binding.kind,
        imported: binding.imported,
        local
      });
    }
  }
  return index;
}

function resolveVueImportedCall(dep, raw, bindingIndex, symbolsByFile) {
  if (dep.from_language !== "vue") return null;
  const parts = raw.split(".");
  const root = parts[0];
  const byLocal = bindingIndex.get(dep.from_file);
  if (!byLocal) return null;

  let bindings = [];
  let importedName = null;
  if (parts.length === 1) {
    bindings = (byLocal.get(root) ?? [])
      .filter((binding) => binding.kind === "named");
    if (bindings.length === 1) importedName = bindings[0].imported;
  } else if (parts.length === 2) {
    bindings = (byLocal.get(root) ?? [])
      .filter((binding) => binding.kind === "namespace");
    if (bindings.length === 1) importedName = parts[1];
  } else {
    return null;
  }

  if (bindings.length === 0) return null;
  if (bindings.length !== 1 || !importedName) {
    return {
      resolved: null,
      resolution: "vue_import_binding_ambiguous",
      candidateCount: bindings.length
    };
  }

  const binding = bindings[0];
  const candidates = (symbolsByFile.get(binding.module_file) ?? [])
    .filter((symbol) => symbol.name === importedName);
  return {
    resolved: candidates.length === 1 ? candidates[0] : null,
    resolution: candidates.length === 1
      ? "vue_import_binding_symbol"
      : (candidates.length > 1
        ? "vue_import_target_ambiguous"
        : "vue_import_target_missing"),
    candidateCount: candidates.length,
    binding
  };
}

function resolveDependencies(db) {
  const symbols = db.prepare(
    `SELECT s.symbol_id,s.file_path,s.language,s.name,s.qualified_name,s.receiver,s.params_json,s.returns_json,
            COALESCE(f.is_test,0) AS is_test,f.package_name
       FROM symbols s
       LEFT JOIN files f ON f.path=s.file_path`
  ).all();

  const byQualified = new Map();
  const byName = new Map();
  const symbolsByFile = new Map();
  const receiverGroups = new Map();
  const symbolIds = new Set(symbols.map((symbol) => symbol.symbol_id));
  const vueImportBindings = buildVueImportBindingIndex(db);

  for (const symbol of symbols) {
    if (!byQualified.has(symbol.qualified_name)) byQualified.set(symbol.qualified_name, []);
    byQualified.get(symbol.qualified_name).push(symbol);
    if (!byName.has(symbol.name)) byName.set(symbol.name, []);
    byName.get(symbol.name).push(symbol);
    if (!symbolsByFile.has(symbol.file_path)) symbolsByFile.set(symbol.file_path, []);
    symbolsByFile.get(symbol.file_path).push(symbol);

    if (!symbol.receiver || symbol.is_test) continue;
    const receiverBase = goTypeBase(symbol.receiver);
    if (!receiverBase) continue;
    const dir = path.posix.dirname(String(symbol.file_path).replaceAll("\\", "/"));
    const key = `${dir}::${receiverBase}`;
    if (!receiverGroups.has(key)) {
      receiverGroups.set(key, {
        key,
        dir,
        receiver: receiverBase,
        package_name: symbol.package_name ?? null,
        methods: new Map()
      });
    }
    const group = receiverGroups.get(key);
    if (!group.methods.has(symbol.name)) group.methods.set(symbol.name, []);
    group.methods.get(symbol.name).push(symbol);
  }

  const deps = db.prepare(
    `SELECT d.id,d.from_file,d.to_ref,d.resolved_symbol_id,d.metadata_json,
            COALESCE(f.is_test,0) AS is_test,f.language AS from_language,f.package_name AS from_package_name
       FROM dependencies d
       LEFT JOIN files f ON f.path=d.from_file
      WHERE d.relation='calls'
      ORDER BY d.id`
  ).all();
  const update = db.prepare(
    "UPDATE dependencies SET resolved_symbol_id=?, metadata_json=? WHERE id=?"
  );

  for (const dep of deps) {
    const raw = String(dep.to_ref ?? "");
    const metadata = parseJson(dep.metadata_json, {});
    if (metadata.compiler_checked === true) {
      const compilerResolved = dep.resolved_symbol_id && symbolIds.has(dep.resolved_symbol_id)
        ? dep.resolved_symbol_id
        : null;
      update.run(
        compilerResolved,
        JSON.stringify({
          ...metadata,
          resolution: compilerResolved ? (metadata.resolution ?? "ts_type_checker") : "ts_call_unresolved"
        }),
        dep.id
      );
      continue;
    }

    if (metadata.go_types_checked === true) {
      const goResolved = dep.resolved_symbol_id && symbolIds.has(dep.resolved_symbol_id)
        ? dep.resolved_symbol_id
        : null;
      const goResolution = goResolved
        ? (metadata.resolution ?? "go_types_object")
        : (metadata.resolution === "go_types_object"
          ? "go_types_target_missing"
          : (metadata.resolution ?? "go_types_call_unresolved"));
      update.run(
        goResolved,
        JSON.stringify({
          ...metadata,
          resolution: goResolution
        }),
        dep.id
      );
      continue;
    }

    const vueImported = resolveVueImportedCall(
      dep, raw, vueImportBindings, symbolsByFile
    );
    if (vueImported) {
      update.run(
        vueImported.resolved?.symbol_id ?? null,
        JSON.stringify({
          ...metadata,
          resolution: vueImported.resolution,
          candidate_count: vueImported.candidateCount,
          ...(vueImported.binding ? {
            import_source_id: vueImported.binding.import_id,
            module_ref: vueImported.binding.module_ref,
            module_file: vueImported.binding.module_file,
            binding_kind: vueImported.binding.kind,
            local_binding: vueImported.binding.local,
            imported_name: vueImported.binding.imported
          } : {})
        }),
        dep.id
      );
      continue;
    }

    const tail = raw.split(".").pop();
    const exact = (byQualified.get(raw) ?? [])
      .filter((candidate) => callCandidateInScope(dep, candidate));
    let resolved = null;
    let resolution = "call_unresolved";
    let resolvedReceiver = null;
    let resolvedPackage = null;
    let candidateCount = null;

    if (metadata.call_kind === "receiver_method" && metadata.receiver_type) {
      const dir = path.posix.dirname(String(dep.from_file).replaceAll("\\", "/"));
      const group = receiverGroups.get(`${dir}::${goTypeBase(metadata.receiver_type)}`);
      const candidates = group?.methods.get(metadata.method || tail) ?? [];
      candidateCount = candidates.length;
      if (candidates.length === 1) {
        resolved = candidates[0];
        resolvedReceiver = group.receiver;
        resolvedPackage = group.package_name;
        resolution = "receiver_type";
      } else {
        resolution = candidates.length > 1
          ? "receiver_method_ambiguous"
          : "receiver_method_not_found";
      }
    } else if (metadata.call_kind === "receiver_field_method" && metadata.field_type) {
      if (metadata.field_kind === "interface") {
        const interfaceMethods = Array.isArray(metadata.interface_methods)
          ? metadata.interface_methods
          : [];
        if (metadata.interface_complete !== true || interfaceMethods.length === 0) {
          resolution = "receiver_field_interface_incomplete";
        } else {
          const groups = [];
          for (const group of receiverGroups.values()) {
            let implementsInterface = true;
            for (const method of interfaceMethods) {
              const candidates = group.methods.get(method.name) ?? [];
              if (!candidates.some((candidate) => methodMatchesShape(candidate, method))) {
                implementsInterface = false;
                break;
              }
            }
            if (implementsInterface) groups.push(group);
          }
          candidateCount = groups.length;
          if (groups.length === 1) {
            const group = groups[0];
            const methodShape = interfaceMethods.find((item) => item.name === (metadata.method || tail));
            const targetCandidates = (group.methods.get(metadata.method || tail) ?? [])
              .filter((candidate) => !methodShape || methodMatchesShape(candidate, methodShape));
            if (targetCandidates.length === 1) {
              resolved = targetCandidates[0];
              resolvedReceiver = group.receiver;
              resolvedPackage = group.package_name;
              resolution = "receiver_field_interface_unique_implementation";
            } else {
              resolution = "receiver_field_interface_target_ambiguous";
            }
          } else {
            resolution = groups.length > 1
              ? "receiver_field_interface_ambiguous_implementation"
              : "receiver_field_interface_no_implementation";
          }
        }
      } else if (metadata.field_kind === "concrete") {
        const rawFieldType = String(metadata.field_type);
        if (!rawFieldType.includes(".") && !["[", "]", "{", "}"].some((token) => rawFieldType.includes(token))) {
          const dir = path.posix.dirname(String(dep.from_file).replaceAll("\\", "/"));
          const group = receiverGroups.get(`${dir}::${goTypeBase(rawFieldType)}`);
          const candidates = group?.methods.get(metadata.method || tail) ?? [];
          candidateCount = candidates.length;
          if (candidates.length === 1) {
            resolved = candidates[0];
            resolvedReceiver = group.receiver;
            resolvedPackage = group.package_name;
            resolution = "receiver_field_concrete_type";
          } else {
            resolution = candidates.length > 1
              ? "receiver_field_concrete_ambiguous"
              : "receiver_field_concrete_not_found";
          }
        } else {
          resolution = "receiver_field_concrete_external_unresolved";
        }
      } else {
        resolution = "receiver_field_type_unresolved";
      }
    } else if (exact.length === 1) {
      resolved = exact[0];
      resolution = "qualified_name";
    } else if (!raw.includes(".")) {
      const simple = (byName.get(tail) ?? [])
        .filter((candidate) => callCandidateInScope(dep, candidate));
      candidateCount = simple.length;
      if (simple.length === 1) {
        resolved = simple[0];
        resolution = "unique_symbol_name";
      } else {
        resolution = simple.length > 1 ? "symbol_name_ambiguous" : "symbol_not_found";
      }
    } else {
      resolution = "selector_receiver_unresolved";
    }

    const nextMetadata = {
      ...metadata,
      resolution,
      ...(resolvedReceiver ? { resolved_receiver: resolvedReceiver } : {}),
      ...(resolvedPackage ? { resolved_package: resolvedPackage } : {}),
      ...(candidateCount === null ? {} : { candidate_count: candidateCount })
    };
    update.run(resolved?.symbol_id ?? null, JSON.stringify(nextMetadata), dep.id);
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
      const target = db.prepare(
        `SELECT s.file_path,COALESCE(f.is_test,0) AS is_test
           FROM symbols s
           LEFT JOIN files f ON f.path=s.file_path
          WHERE s.symbol_id=?`
      ).get(dep.resolved_symbol_id);
      if (target && !target.is_test && target.file_path !== testFile) {
        candidates.push({
          file: target.file_path,
          symbol: dep.resolved_symbol_id,
          confidence: 0.90,
          reason: "test_calls_symbol"
        });
      }
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

function isCompilerScriptLanguage(language) {
  return language === "typescript" || language === "javascript";
}

function canAffectVueModuleResolution(language) {
  return language === "typescript"
    || language === "javascript"
    || language === "vue";
}

function isGoProjectConfig(relPath) {
  return /(?:^|\/)(?:go\.mod|go\.sum|go\.work|go\.work\.sum)$/i.test(
    String(relPath ?? "").replaceAll("\\", "/")
  );
}

function isCompilerProjectConfig(relPath) {
  return /(?:^|\/)(?:tsconfig|jsconfig)(?:\.[^/]*)?\.json$/i.test(
    String(relPath ?? "").replaceAll("\\", "/")
  );
}

function addCompilerReverseInvalidations(db, seeds, snapshots, pendingMap, skippedPaths) {
  const queue = [...new Set(seeds)];
  const seen = new Set();
  const reverse = db.prepare(
    "SELECT DISTINCT from_file FROM dependencies WHERE relation='imports' AND to_file=? ORDER BY from_file"
  );
  while (queue.length) {
    const target = queue.shift();
    if (seen.has(target)) continue;
    seen.add(target);
    for (const row of reverse.all(target)) {
      const item = snapshots.get(row.from_file);
      if (!item || !isCompilerScriptLanguage(item.language)) continue;
      if (!pendingMap.has(item.relPath)) pendingMap.set(item.relPath, item);
      skippedPaths.delete(item.relPath);
      queue.push(item.relPath);
    }
  }
}

export async function indexRepository({ repoRoot, indexDir = ".context-index", force = false, analyzerRegistry = DEFAULT_ANALYZERS } = {}) {
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
    let changed = 0, unreadable = 0;
    const unreadableDiagnostics = [];
    const snapshots = new Map();
    const pendingMap = new Map();
    const skippedPaths = new Set();
    const compilerSeeds = [];
    const goTypedProject = tracked.some((relPath) =>
      /(?:^|\/)(?:go\.mod|go\.work)$/.test(relPath)
    );
    let goTypeGraphChanged = removed.some(isGoProjectConfig);
    let compilerStructureChanged = false;
    let vueStructureChanged = false;
    let compilerConfigChanged = removed.some(isCompilerProjectConfig);

    for (const relPath of tracked) {
      let text;
      try {
        text = await readLocalSource(gitRoot, relPath);
      } catch (error) {
        unreadable++;
        unreadableDiagnostics.push({
          file: relPath, analyzer_id: "source-reader", severity: "error",
          code: "source_read_failed", message: error.message, status: "failed"
        });
        continue;
      }
      if (text === null) {
        unreadable++;
        unreadableDiagnostics.push({
          file: relPath, analyzer_id: "source-reader", severity: "error",
          code: "unreadable_source", message: "symlink, non-text, or oversized source",
          status: "failed"
        });
        continue;
      }
      const contentHash = sha256Text(text);
      const old = existingMap.get(relPath);
      const language = detectLanguage(relPath);
      const item = { relPath, text, contentHash, language };
      snapshots.set(relPath, item);
      const parserVersion = parserVersionFor(language, analyzerRegistry);
      const contentChanged = old?.content_hash !== contentHash;
      const parserChanged = old?.parser_version !== parserVersion;
      if (!force && !contentChanged && !parserChanged) {
        skippedPaths.add(relPath);
        continue;
      }
      pendingMap.set(relPath, item);
      if (isCompilerProjectConfig(relPath) && contentChanged) compilerConfigChanged = true;
      if (isGoProjectConfig(relPath) && contentChanged) {
        goTypeGraphChanged = true;
      }
      if (language === "go" && contentChanged && goTypedProject) {
        goTypeGraphChanged = true;
      }
      if (isCompilerScriptLanguage(language) && contentChanged) {
        compilerSeeds.push(relPath);
        if (!old) compilerStructureChanged = true;
      }
      if (!old && contentChanged && canAffectVueModuleResolution(language)) {
        vueStructureChanged = true;
      }
    }

    for (const filePath of removed) {
      const oldLanguage = db.prepare("SELECT language FROM files WHERE path=?").get(filePath)?.language;
      if (oldLanguage === "go" && goTypedProject) goTypeGraphChanged = true;
      if (isCompilerScriptLanguage(oldLanguage)) compilerSeeds.push(filePath);
      if (canAffectVueModuleResolution(oldLanguage)) vueStructureChanged = true;
    }

    if (goTypeGraphChanged) {
      for (const item of snapshots.values()) {
        if (item.language !== "go") continue;
        pendingMap.set(item.relPath, item);
        skippedPaths.delete(item.relPath);
      }
    }

    if (compilerConfigChanged || compilerStructureChanged) {
      for (const item of snapshots.values()) {
        if (!isCompilerScriptLanguage(item.language)) continue;
        pendingMap.set(item.relPath, item);
        skippedPaths.delete(item.relPath);
      }
    } else {
      addCompilerReverseInvalidations(
        db, compilerSeeds, snapshots, pendingMap, skippedPaths
      );
    }

    if (vueStructureChanged) {
      for (const item of snapshots.values()) {
        if (item.language !== "vue") continue;
        pendingMap.set(item.relPath, item);
        skippedPaths.delete(item.relPath);
      }
    }
    const pending = [...pendingMap.values()];

    const analyzed = await analyzePendingFiles({
      repoRoot: gitRoot, pending, trackedSet, registry: analyzerRegistry
    });
    analyzed.diagnostics.unshift(...unreadableDiagnostics);
    const successful = pending.filter((item) => analyzed.results.has(item.relPath));

    transaction(db, () => {
      for (const filePath of removed) {
        const oldSymbols = db.prepare("SELECT symbol_id,implementation_hash,semantic_hash FROM symbols WHERE file_path=?").all(filePath);
        markFeaturesForSymbolChange(db, oldSymbols.map((x)=>x.symbol_id), "referenced_file_removed");
        markFeaturesForFileChange(db, filePath, "referenced_file_removed");
        for (const old of oldSymbols) db.prepare(`INSERT INTO change_events(indexed_at,kind,file_path,symbol_id,old_hash,new_hash,detail) VALUES(?,?,?,?,?,?,?)`).run(now,"symbol_removed",filePath,old.symbol_id,old.implementation_hash,null,"file_removed");
        db.prepare("DELETE FROM files WHERE path=?").run(filePath);
      }

      for (const item of successful) {
        const oldSymbols = db.prepare("SELECT symbol_id,implementation_hash,semantic_hash FROM symbols WHERE file_path=?").all(item.relPath);
        markFeaturesForFileChange(db, item.relPath);
        db.prepare("DELETE FROM files WHERE path=?").run(item.relPath);
        const analysis = analyzed.results.get(item.relPath);
        insertAnalysis(db, item.relPath, item.language, item.contentHash, item.text, analysis, now);
        const newSymbols = new Map((analysis.symbols ?? []).map((s)=>[s.symbol_id,s]));
        markOldFeatureRefs(db, item.relPath, oldSymbols, newSymbols, now);
        db.prepare(`INSERT INTO change_events(indexed_at,kind,file_path,symbol_id,old_hash,new_hash,detail) VALUES(?,?,?,?,?,?,?)`).run(now,"file_reindexed",item.relPath,null,existingMap.get(item.relPath)?.content_hash ?? null,item.contentHash,"file_content_or_parser_changed");
        changed++;
      }
      resolveDependencies(db);
      rebuildTestMappings(db);
      rebuildTestEdges(db);
      rebuildDependencyEdges(db);
      rebuildRouteHandlerEdges(db);
      rebuildApiRequestEdges(db);
      rebuildDbObjectEdges(db);
      rebuildPageApiEdges(db);
    });

    const definitions = await loadFeatureDefinitions(gitRoot);
    syncFeatureDefinitions(db, definitions, now);
    refreshFeatureStatus(db, now);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run("last_indexed_at", now);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)")
      .run("repository_root", gitRoot);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)")
      .run("analysis_diagnostics", JSON.stringify(analyzed.diagnostics));
    const manifest = await exportIndex(db, outDir);
    return { ok: true, repository: gitRoot, index_dir: outDir, database: dbPath, changed_files: changed, skipped_files: skippedPaths.size, removed_files: removed.length, unreadable_files: unreadable, analysis_failed_files: analyzed.diagnostics.filter((entry) => entry.status !== "complete").length, diagnostics: analyzed.diagnostics, feature_definitions: definitions.length, manifest };
  } finally {
    db.close();
  }
}
