import { analyzeGoFiles } from "./go-runner.js";
import { analyzeScriptFile } from "./analyze-script.js";
import { analyzeTypeScriptFiles, TYPESCRIPT_ANALYZER_VERSION } from "./analyze-typescript.js";
import { extractDbObjects, extractRoutes } from "./analyze-common.js";
import { PARSER_VERSION } from "./schema.js";

export const ANALYZER_CONTRACT_VERSION = 1;

function descriptor(id, languages, version, evidence, capabilities, analyze) {
  return Object.freeze({
    id, languages: Object.freeze(languages), version, evidence,
    capabilities: Object.freeze({
      symbols: "unsupported", imports: "unsupported", calls: "unsupported",
      types: "unsupported", routes: "heuristic", clientRequests: "heuristic",
      database: "heuristic", tests: "unsupported", exactResolution: "unsupported",
      ...capabilities
    }), analyze
  });
}

export function createAnalyzerRegistry({
  goVersion = "1",
  scriptVersion = TYPESCRIPT_ANALYZER_VERSION,
  vueVersion = "1",
  textVersion = "1",
  goAnalyze = ({ repoRoot, items }) => analyzeGoFiles(repoRoot, items.map((item) => item.relPath)),
  scriptAnalyze = ({ repoRoot, items, trackedSet }) => analyzeTypeScriptFiles({
    repoRoot, items, trackedSet
  }),
  vueAnalyze = ({ items, trackedSet }) => new Map(items.map((item) => [
    item.relPath, analyzeScriptFile({
      text: item.text, relPath: item.relPath,
      language: item.language, trackedSet
    })
  ]))
} = {}) {
  return Object.freeze([
    descriptor("go-ast", ["go"], goVersion, "ast",
      { symbols: "static", imports: "static", calls: "static", types: "heuristic", exactResolution: "unsupported" },
      goAnalyze),
    descriptor("typescript-compiler", ["typescript", "javascript"], scriptVersion, "ast",
      { symbols: "static", imports: "static", calls: "static", types: "static", exactResolution: "static" },
      scriptAnalyze),
    descriptor("script-regex", ["vue"], vueVersion, "text",
      { symbols: "heuristic", imports: "heuristic", calls: "heuristic", types: "unsupported", exactResolution: "unsupported" },
      vueAnalyze),
    descriptor("text-facts", ["*"], textVersion, "text",
      { symbols: "unsupported", imports: "unsupported", calls: "unsupported", routes: "heuristic", database: "heuristic" },
      ({ items }) => new Map(items.map((item) => [
        item.relPath, { symbols: [], dependencies: [] }
      ])))
  ]);
}

export const DEFAULT_ANALYZERS = createAnalyzerRegistry();

export function analyzerFor(language, registry = DEFAULT_ANALYZERS) {
  return registry.find((entry) => entry.languages.includes(language))
    ?? registry.find((entry) => entry.languages.includes("*"))
    ?? null;
}

export function parserVersionFor(language, registry = DEFAULT_ANALYZERS) {
  const analyzer = analyzerFor(language, registry);
  if (!analyzer) throw new Error("no analyzer for language: " + language);
  return PARSER_VERSION + "/contract" + ANALYZER_CONTRACT_VERSION
    + "/" + analyzer.id + "@" + analyzer.version;
}

function diagnostic(file, analyzer, code, message, status = "failed") {
  return {
    file, analyzer_id: analyzer.id, severity: "error", code,
    message: String(message), status
  };
}

function normalizedFacts(item, raw, analyzer) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.symbols)
    || !Array.isArray(raw.dependencies)
    || (raw.tests !== undefined && !Array.isArray(raw.tests))) {
    throw new Error("analyzer must return symbols and dependencies arrays");
  }
  for (const symbol of raw.symbols) {
    if (!symbol || typeof symbol.symbol_id !== "string" || symbol.file_path !== item.relPath
      || typeof symbol.name !== "string" || typeof symbol.qualified_name !== "string"
      || typeof symbol.kind !== "string"
      || typeof symbol.implementation_hash !== "string"
      || typeof symbol.semantic_hash !== "string") {
      throw new Error("invalid symbol file or required fields");
    }
  }
  for (const dep of raw.dependencies) {
    if (!dep || dep.from_file !== item.relPath || !["calls", "imports"].includes(dep.relation)
      || typeof dep.to_ref !== "string") {
      throw new Error("invalid dependency");
    }
  }
  const provenance = Object.freeze({
    analyzer_id: analyzer.id, analyzer_version: analyzer.version,
    parser_version: parserVersionFor(item.language, [analyzer]),
    evidence: analyzer.evidence
  });
  const symbols = raw.symbols.map((fact) => ({ ...fact, provenance }));
  const dependencies = raw.dependencies.map((fact) => ({ ...fact, provenance }));
  const routes = extractRoutes(item.text, item.relPath, symbols)
    .map((fact) => ({ ...fact, provenance: { ...provenance, evidence: "text_pattern" } }));
  const dbObjects = extractDbObjects(item.text, item.relPath, symbols)
    .map((fact) => ({ ...fact, provenance: { ...provenance, evidence: "text_pattern" } }));
  const diagnostics = (Array.isArray(raw.diagnostics) ? raw.diagnostics : [])
    .map((entry) => ({
      file: item.relPath, analyzer_id: analyzer.id,
      severity: entry.severity ?? "warning", code: entry.code ?? "analyzer_note",
      message: String(entry.message ?? ""), status: "complete"
    }));
  return {
    status: "complete", file: {
      path: item.relPath, language: item.language, content_hash: item.contentHash ?? null
    },
    language: item.language, analyzer_id: analyzer.id,
    parser_version: provenance.parser_version, package: raw.package ?? null,
    symbols, dependencies, routes, dbObjects, tests: raw.tests ?? [], diagnostics
  };
}

// The registry is internal. Failed/partial files are returned as diagnostics
// and are never committed as empty successful analyses by the indexer.
export async function analyzePendingFiles({
  repoRoot, pending, trackedSet, registry = DEFAULT_ANALYZERS
}) {
  const results = new Map();
  const diagnostics = [];
  const groups = new Map();
  for (const item of pending) {
    const analyzer = analyzerFor(item.language, registry);
    if (!analyzer) throw new Error("no analyzer for language: " + item.language);
    if (!groups.has(analyzer)) groups.set(analyzer, []);
    groups.get(analyzer).push(item);
  }

  for (const [analyzer, items] of groups) {
    let output;
    try {
      output = await analyzer.analyze({ repoRoot, items, trackedSet });
      if (!(output instanceof Map)) throw new Error("analyzer must return a Map");
    } catch (error) {
      for (const item of items) {
        diagnostics.push(diagnostic(item.relPath, analyzer, "analyzer_failed", error.message));
      }
      continue;
    }
    for (const item of items) {
      const raw = output.get(item.relPath);
      if (raw?.error) {
        diagnostics.push(diagnostic(item.relPath, analyzer, "parse_failed", raw.error));
        continue;
      }
      if (raw?.status === "partial" || raw?.status === "failed") {
        diagnostics.push(diagnostic(item.relPath, analyzer,
          "incomplete_analysis", raw.diagnostics?.[0]?.message ?? "incomplete analyzer result", raw.status));
        continue;
      }
      try {
        const analysis = normalizedFacts(item, raw, analyzer);
        results.set(item.relPath, analysis);
        diagnostics.push(...analysis.diagnostics);
      } catch (error) {
        diagnostics.push(diagnostic(item.relPath, analyzer, "invalid_facts", error.message));
      }
    }
  }
  return { results, diagnostics };
}
