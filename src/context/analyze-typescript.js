import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { sha256Text, hashObject } from "./hash.js";
import { detectLanguage } from "./language.js";
import { normalizeRel, resolveRelativeImport } from "./utils.js";

const SCRIPT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;
const CONFIG_RE = /(?:^|\/)(?:tsconfig|jsconfig)(?:\.[^/]*)?\.json$/i;

function isScript(relPath) {
  return SCRIPT_RE.test(relPath);
}

function isConfig(relPath) {
  return CONFIG_RE.test(normalizeRel(relPath));
}

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function relFromAbs(repoRoot, absolute) {
  if (!inside(repoRoot, absolute)) return null;
  return normalizeRel(path.relative(repoRoot, absolute));
}

function nearestConfig(relPath, configPaths) {
  const dir = path.posix.dirname(normalizeRel(relPath));
  let best = null;
  for (const config of configPaths) {
    const configDir = path.posix.dirname(config);
    if (dir !== configDir && !dir.startsWith(configDir === "." ? "" : configDir + "/")) continue;
    if (!best || configDir.length > path.posix.dirname(best).length) best = config;
  }
  return best;
}

function defaultCompilerOptions() {
  return {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: []
  };
}

function formatDiagnostic(entry) {
  return ts.flattenDiagnosticMessageText(entry.messageText, " ");
}

function readCompilerOptions(repoRoot, configRel, diagnostics) {
  if (!configRel) return defaultCompilerOptions();
  const configAbs = path.join(repoRoot, configRel);
  const read = ts.readConfigFile(configAbs, ts.sys.readFile);
  if (read.error) {
    diagnostics.push({
      severity: "warning",
      code: "ts_config_read_failed",
      message: configRel + ": " + formatDiagnostic(read.error)
    });
    return defaultCompilerOptions();
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configAbs), {
    noEmit: true,
    allowJs: true,
    skipLibCheck: true
  }, configAbs);
  for (const error of parsed.errors.slice(0, 5)) {
    diagnostics.push({
      severity: "warning",
      code: "ts_config_diagnostic",
      message: configRel + ": " + formatDiagnostic(error)
    });
  }
  return {
    ...parsed.options,
    noEmit: true,
    allowJs: true,
    skipLibCheck: true,
    noLib: true,
    types: []
  };
}

function scriptKind(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(ext)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function createTrackedCompilerHost(repoRoot, trackedSet, options) {
  const base = ts.createCompilerHost(options, true);
  const allowed = (fileName) => {
    const relPath = relFromAbs(repoRoot, path.resolve(fileName));
    return Boolean(relPath && trackedSet.has(relPath));
  };
  base.fileExists = (fileName) => allowed(fileName) && fs.existsSync(fileName);
  base.readFile = (fileName) => {
    if (!allowed(fileName)) return undefined;
    try {
      return fs.readFileSync(fileName, "utf8");
    } catch {
      return undefined;
    }
  };
  base.getSourceFile = (fileName, languageVersion) => {
    const text = base.readFile(fileName);
    if (text === undefined) return undefined;
    return ts.createSourceFile(
      fileName, text, languageVersion, true, scriptKind(fileName)
    );
  };
  base.directoryExists = (dirName) => inside(repoRoot, path.resolve(dirName))
    && fs.existsSync(dirName);
  base.getDirectories = () => [];
  base.realpath = (fileName) => path.resolve(fileName);
  return base;
}

function compilerGroups(items, trackedSet) {
  const configPaths = [...trackedSet].map(normalizeRel).filter(isConfig).sort();
  const scripts = [...trackedSet].map(normalizeRel).filter(isScript).sort();
  const groups = new Map();
  for (const item of items) {
    const key = nearestConfig(item.relPath, configPaths) ?? "<default>";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return { configPaths, scripts, groups };
}

function createCompilerContext(repoRoot, key, configPaths, scripts, trackedSet) {
  const diagnostics = [];
  const configRel = key === "<default>" ? null : key;
  const options = readCompilerOptions(repoRoot, configRel, diagnostics);
  const rootNames = scripts
    .filter((relPath) => (nearestConfig(relPath, configPaths) ?? "<default>") === key)
    .map((relPath) => path.join(repoRoot, relPath));
  let program = null;
  let checker = null;
  let host = null;
  if (fs.existsSync(repoRoot) && rootNames.length) {
    host = createTrackedCompilerHost(repoRoot, trackedSet, options);
    program = ts.createProgram({ rootNames, options, host });
    checker = program.getTypeChecker();
  }
  return { configRel, options, program, checker, host, diagnostics };
}

function precedingComment(text, start) {
  const prefix = text.slice(Math.max(0, start - 800), start);
  const jsdoc = prefix.match(/\/\*\*([\s\S]*?)\*\/\s*$/);
  if (jsdoc) {
    return jsdoc[1].split("\n").map((line) => line.replace(/^\s*\*?\s?/, ""))
      .join(" ").replace(/\s+/g, " ").trim();
  }
  const lines = prefix.split("\n");
  const comments = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (line.startsWith("//")) comments.unshift(line.slice(2).trim());
    else if (line === "") continue;
    else break;
  }
  return comments.join(" ").trim();
}

function declarationName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.name.text;
  }
  return null;
}

function declarationFunctionNode(node) {
  if (ts.isFunctionDeclaration(node)) return node;
  if (ts.isVariableDeclaration(node) && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.initializer;
  }
  return null;
}

function supportedDeclaration(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node;
  if (ts.isVariableDeclaration(node) && declarationName(node)) return node;
  return null;
}

function symbolIdForDeclaration(node, repoRoot, trackedSet) {
  const supported = supportedDeclaration(node);
  if (!supported) return null;
  const sourceFile = node.getSourceFile();
  const relPath = relFromAbs(repoRoot, sourceFile.fileName);
  if (!relPath || !trackedSet.has(relPath)) return null;
  const name = declarationName(supported);
  if (!name) return null;
  return detectLanguage(relPath) + ":" + relPath + "::" + name;
}

function callRef(expression, sourceFile) {
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    return expression.getText(sourceFile);
  }
  return null;
}

function hasExportModifier(node) {
  return Array.isArray(node.modifiers)
    && node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function trackedExportTargets(moduleFile, exportedName, context, repoRoot, trackedSet, seen = new Set()) {
  const key = moduleFile + "::" + exportedName;
  if (seen.has(key) || !context?.program) return new Set();
  const nextSeen = new Set(seen);
  nextSeen.add(key);
  const sourceFile = context.program.getSourceFile(path.join(repoRoot, moduleFile));
  if (!sourceFile) return new Set();
  const targets = new Set();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name
      && statement.name.text === exportedName && hasExportModifier(statement)) {
      const id = symbolIdForDeclaration(statement, repoRoot, trackedSet);
      if (id) targets.add(id);
      continue;
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== exportedName) continue;
        const id = symbolIdForDeclaration(declaration, repoRoot, trackedSet);
        if (id) targets.add(id);
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement)) continue;
    if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const targetModule = moduleResolution(
        statement.moduleSpecifier.text, sourceFile, context, repoRoot, trackedSet
      ).toFile;
      if (!targetModule) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.name.text !== exportedName) continue;
          const imported = element.propertyName?.text ?? element.name.text;
          for (const id of trackedExportTargets(
            targetModule, imported, context, repoRoot, trackedSet, nextSeen
          )) targets.add(id);
        }
      } else if (!statement.exportClause) {
        for (const id of trackedExportTargets(
          targetModule, exportedName, context, repoRoot, trackedSet, nextSeen
        )) targets.add(id);
      }
    }
  }
  return targets;
}

function importedIdentifierTargets(expression, sourceFile, context, repoRoot, trackedSet) {
  if (!ts.isIdentifier(expression)) return null;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause
      || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const named = statement.importClause.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      if (element.name.text !== expression.text) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      const targetModule = moduleResolution(
        statement.moduleSpecifier.text, sourceFile, context, repoRoot, trackedSet
      ).toFile;
      if (!targetModule) return new Set();
      return trackedExportTargets(
        targetModule, imported, context, repoRoot, trackedSet
      );
    }
  }
  return null;
}

function dynamicImportBindings(sourceFile) {
  const names = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init = node.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;
      if (ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword) {
        names.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function propertyRootIdentifier(expression) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : null;
}

function resolvedCallSymbol(call, context, repoRoot, trackedSet, dynamicBindings) {
  const checker = context?.checker;
  if (!checker) return null;
  const sourceFile = call.getSourceFile();
  if (ts.isPropertyAccessExpression(call.expression)) {
    const root = propertyRootIdentifier(call.expression);
    if (root && dynamicBindings.has(root)) return null;
  }
  const importedTargets = importedIdentifierTargets(
    call.expression, sourceFile, context, repoRoot, trackedSet
  );
  if (importedTargets) {
    if (importedTargets.size !== 1) return null;
    return [...importedTargets][0];
  }
  let symbol = checker.getSymbolAtLocation(call.expression);
  if (!symbol && ts.isPropertyAccessExpression(call.expression)) {
    symbol = checker.getSymbolAtLocation(call.expression.name);
  }
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return null;
    }
  }
  const candidates = new Set();
  for (const declaration of symbol.declarations ?? []) {
    const id = symbolIdForDeclaration(declaration, repoRoot, trackedSet);
    if (id) candidates.add(id);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

function parseBindings(importClause) {
  const bindings = [];
  if (!importClause) return bindings;
  if (importClause.name) {
    bindings.push({ kind: "default", imported: "default", local: importClause.name.text });
  }
  const named = importClause.namedBindings;
  if (named && ts.isNamespaceImport(named)) {
    bindings.push({ kind: "namespace", imported: "*", local: named.name.text });
  } else if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) {
      bindings.push({
        kind: "named",
        imported: element.propertyName?.text ?? element.name.text,
        local: element.name.text
      });
    }
  }
  return bindings;
}

function moduleResolution(specifier, sourceFile, context, repoRoot, trackedSet) {
  const containing = sourceFile.fileName;
  const result = ts.resolveModuleName(
    specifier, containing, context.options, context.host ?? ts.sys
  ).resolvedModule;
  if (result?.resolvedFileName) {
    const relPath = relFromAbs(repoRoot, result.resolvedFileName);
    if (relPath && trackedSet.has(relPath)) {
      return { toFile: relPath, resolution: "ts_module_resolution" };
    }
    return { toFile: null, resolution: "external_or_untracked_module" };
  }
  const fallback = resolveRelativeImport(
    relFromAbs(repoRoot, containing) ?? sourceFile.fileName,
    specifier,
    trackedSet
  );
  if (fallback) return { toFile: fallback, resolution: "tracked_fallback" };
  return { toFile: null, resolution: "module_unresolved" };
}

function addDependency(out, seen, dep) {
  const key = [
    dep.relation, dep.from_symbol_id ?? "", dep.to_ref, dep.to_file ?? "",
    dep.metadata?.import_kind ?? "", dep.metadata?.resolution ?? ""
  ].join("|");
  if (seen.has(key)) return;
  seen.add(key);
  out.push(dep);
}

function extractImports(sourceFile, relPath, context, repoRoot, trackedSet, diagnostics) {
  const dependencies = [];
  const seen = new Set();
  const addModule = (specifier, metadata, fromSymbolId = null, forceUnresolved = false) => {
    const resolved = forceUnresolved
      ? { toFile: null, resolution: "dynamic_import_unresolved" }
      : moduleResolution(specifier, sourceFile, context, repoRoot, trackedSet);
    addDependency(dependencies, seen, {
      from_file: relPath,
      from_symbol_id: fromSymbolId,
      relation: "imports",
      to_ref: specifier,
      to_file: resolved.toFile,
      resolved_symbol_id: null,
      metadata: { ...metadata, resolution: resolved.resolution }
    });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      addModule(statement.moduleSpecifier.text, {
        import_kind: "from",
        import_bindings: parseBindings(statement.importClause)
      });
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier
      && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const bindings = [];
      let kind = "re_export_all";
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        kind = "re_export";
        for (const element of statement.exportClause.elements) {
          bindings.push({
            kind: "named",
            imported: element.propertyName?.text ?? element.name.text,
            local: element.name.text,
            exported: element.name.text
          });
        }
      }
      addModule(statement.moduleSpecifier.text, { import_kind: kind, import_bindings: bindings });
    }
  }

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        const specifier = arg && ts.isStringLiteralLike(arg) ? arg.text : "<dynamic>";
        addModule(specifier, { import_kind: "dynamic", import_bindings: [] }, null, true);
        diagnostics.push({
          severity: "warning",
          code: "dynamic_import_unresolved",
          message: relPath + ": dynamic import kept unresolved"
        });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require"
        && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
        const specifier = node.arguments[0].text;
        let bindings = [];
        const parent = node.parent;
        if (ts.isVariableDeclaration(parent)) {
          if (ts.isIdentifier(parent.name)) {
            bindings = [{ kind: "namespace", imported: "*", local: parent.name.text }];
          } else if (ts.isObjectBindingPattern(parent.name)) {
            bindings = parent.name.elements.map((element) => ({
              kind: "named",
              imported: element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile),
              local: element.name.getText(sourceFile)
            }));
          }
        }
        addModule(specifier, { import_kind: "require", import_bindings: bindings });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return dependencies;
}

function makeSymbol(node, sourceFile, relPath, language, context, repoRoot, trackedSet, dynamicBindings) {
  const name = declarationName(node);
  const fn = declarationFunctionNode(node);
  if (!name || !fn) return null;
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const params = fn.parameters.map((param) => ({
    name: param.name.getText(sourceFile).replace(/[?]/g, ""),
    type: param.type?.getText(sourceFile) ?? null
  }));
  const returns = fn.type ? [{ type: fn.type.getText(sourceFile) }] : [];
  const calls = [];
  const callDeps = [];
  const seenCalls = new Set();
  const fromSymbolId = language + ":" + relPath + "::" + name;

  const visit = (child) => {
    if (ts.isCallExpression(child)) {
      if (child.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(child.expression) && child.expression.text === "require")) {
        return;
      }
      const ref = callRef(child.expression, sourceFile);
      if (ref && !seenCalls.has(ref)) {
        seenCalls.add(ref);
        calls.push(ref);
        const resolved = resolvedCallSymbol(child, context, repoRoot, trackedSet, dynamicBindings);
        callDeps.push({
          from_file: relPath,
          from_symbol_id: fromSymbolId,
          relation: "calls",
          to_ref: ref,
          to_file: null,
          resolved_symbol_id: resolved,
          metadata: {
            compiler_checked: true,
            resolution: resolved ? "ts_type_checker" : "ts_call_unresolved"
          }
        });
      }
    }
    ts.forEachChild(child, visit);
  };
  if (fn.body) visit(fn.body);

  const comment = precedingComment(sourceFile.text, start);
  const signatureEnd = fn.body ? fn.body.getStart(sourceFile) : end;
  const signature = sourceFile.text.slice(start, signatureEnd).replace(/\s+/g, " ").trim();
  const description = comment || name + "(" + params.map((param) => param.name).join(", ")
    + ") in " + relPath + (calls.length ? "; calls " + calls.slice(0, 8).join(", ") : "") + ".";
  const semantic = { name, kind: "function", signature, params, returns, description, calls };

  return {
    symbol: {
      symbol_id: fromSymbolId,
      file_path: relPath,
      language,
      name,
      qualified_name: name,
      kind: "function",
      receiver: null,
      signature,
      params,
      returns,
      description,
      description_source: comment ? "comment" : "derived",
      line_start: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
      line_end: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
      implementation_hash: sha256Text(sourceFile.text.slice(start, end)),
      semantic_hash: hashObject(semantic),
      calls
    },
    callDeps
  };
}

function extractSymbols(sourceFile, relPath, language, context, repoRoot, trackedSet) {
  const symbols = [];
  const dependencies = [];
  const dynamicBindings = dynamicImportBindings(sourceFile);
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const built = makeSymbol(statement, sourceFile, relPath, language, context, repoRoot, trackedSet, dynamicBindings);
      if (built) {
        symbols.push(built.symbol);
        dependencies.push(...built.callDeps);
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const built = makeSymbol(declaration, sourceFile, relPath, language, context, repoRoot, trackedSet, dynamicBindings);
        if (built) {
          symbols.push(built.symbol);
          dependencies.push(...built.callDeps);
        }
      }
    }
  }
  return { symbols, dependencies };
}

function sourceDiagnostics(context, sourceFile, relPath) {
  if (!context.program || !sourceFile) return [];
  const relevantCodes = new Set([2307, 2792, 7016]);
  const diagnostics = [
    ...context.program.getSyntacticDiagnostics(sourceFile),
    ...context.program.getSemanticDiagnostics(sourceFile).filter((entry) => relevantCodes.has(entry.code))
  ];
  return diagnostics.slice(0, 8).map((entry) => ({
    severity: entry.category === ts.DiagnosticCategory.Error ? "warning" : "info",
    code: "ts_" + entry.code,
    message: relPath + ": " + formatDiagnostic(entry)
  }));
}

export function analyzeTypeScriptFiles({ repoRoot, items, trackedSet }) {
  const output = new Map();
  const normalizedTracked = new Set([...trackedSet].map(normalizeRel));
  const { configPaths, scripts, groups } = compilerGroups(
    items, normalizedTracked
  );

  for (const [key, groupItems] of groups) {
    const context = createCompilerContext(
      repoRoot, key, configPaths, scripts, normalizedTracked
    );
    for (const item of groupItems) {
      const relPath = normalizeRel(item.relPath);
      const absolute = path.join(repoRoot, relPath);
      const sourceFile = context.program?.getSourceFile(absolute)
        ?? ts.createSourceFile(
          relPath, item.text, ts.ScriptTarget.Latest, true,
          item.language === "typescript" ? ts.ScriptKind.TS : ts.ScriptKind.JS
        );
      const diagnostics = [
        ...context.diagnostics,
        ...sourceDiagnostics(context, sourceFile, relPath)
      ];
      const imports = extractImports(
        sourceFile, relPath, context, repoRoot, normalizedTracked, diagnostics
      );
      const facts = extractSymbols(
        sourceFile, relPath, item.language, context,
        repoRoot, normalizedTracked
      );
      output.set(relPath, {
        symbols: facts.symbols,
        dependencies: [...imports, ...facts.dependencies],
        diagnostics
      });
    }
    context.checker = null;
    context.program = null;
    context.host = null;
  }
  return output;
}

export const TYPESCRIPT_ANALYZER_VERSION = ts.version;
