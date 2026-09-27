import { parse, version as compilerSfcVersion } from "@vue/compiler-sfc";
import { analyzeScriptFile } from "./analyze-script.js";
import { resolveRelativeImport } from "./utils.js";

const COMPILER_MACROS = new Set([
  "defineProps", "defineEmits", "defineExpose", "defineOptions",
  "defineSlots", "defineModel", "withDefaults"
]);

function messageOf(error) {
  if (typeof error === "string") return error;
  return String(error?.message ?? error ?? "unknown Vue SFC parse error");
}

function scriptLanguage(block) {
  const lang = String(block?.lang ?? "js").toLowerCase();
  if (lang === "ts" || lang === "tsx") return "typescript";
  if (lang === "js" || lang === "jsx") return "javascript";
  return null;
}

function paddedBlockSource(fullText, block) {
  const offset = Number(block?.loc?.start?.offset ?? 0);
  const prefix = fullText.slice(0, offset).replace(/[^\r\n]/g, " ");
  return prefix + String(block?.content ?? "");
}

function remapSymbol(symbol, relPath, sourceLanguage) {
  const prefix = sourceLanguage + ":" + relPath + "::";
  const suffix = symbol.symbol_id.startsWith(prefix)
    ? symbol.symbol_id.slice(prefix.length)
    : symbol.name;
  return {
    ...symbol,
    symbol_id: "vue:" + relPath + "::" + suffix,
    language: "vue"
  };
}

function remapDependency(dep, relPath, sourceLanguage) {
  const prefix = sourceLanguage + ":" + relPath + "::";
  let fromSymbolId = dep.from_symbol_id;
  if (fromSymbolId?.startsWith(prefix)) {
    fromSymbolId = "vue:" + relPath + "::" + fromSymbolId.slice(prefix.length);
  }
  return { ...dep, from_symbol_id: fromSymbolId };
}

function dependencyKey(dep) {
  return JSON.stringify([
    dep.relation,
    dep.from_symbol_id ?? null,
    dep.to_ref,
    dep.to_file ?? null,
    dep.metadata ?? {}
  ]);
}

function scriptSrcDependency(relPath, block, trackedSet) {
  if (!block?.src) return null;
  return {
    from_file: relPath,
    from_symbol_id: null,
    relation: "imports",
    to_ref: block.src,
    to_file: resolveRelativeImport(relPath, block.src, trackedSet),
    resolved_symbol_id: null,
    metadata: {
      import_kind: block.setup ? "vue_script_setup_src" : "vue_script_src",
      import_bindings: []
    }
  };
}

export function analyzeVueFile({ text, relPath, trackedSet }) {
  const parsed = parse(text, {
    filename: relPath,
    sourceMap: false
  });

  if (parsed.errors.length) {
    return {
      status: "partial",
      symbols: [],
      dependencies: [],
      diagnostics: parsed.errors.map((error) => ({
        severity: "error",
        code: "vue_sfc_parse_failed",
        message: messageOf(error)
      }))
    };
  }

  const blocks = [
    ["script", parsed.descriptor.script],
    ["script_setup", parsed.descriptor.scriptSetup]
  ].filter(([, block]) => Boolean(block));

  const symbols = [];
  const dependencies = [];
  const diagnostics = [];
  const symbolIds = new Set();
  const depKeys = new Set();

  for (const [kind, block] of blocks) {
    const sourceLanguage = scriptLanguage(block);
    if (!sourceLanguage) {
      return {
        status: "partial",
        symbols: [],
        dependencies: [],
        diagnostics: [{
          severity: "error",
          code: "vue_script_lang_unsupported",
          message: kind + " uses unsupported lang=" + String(block.lang)
        }]
      };
    }

    const srcDep = scriptSrcDependency(relPath, block, trackedSet);
    if (srcDep) {
      const key = dependencyKey(srcDep);
      if (!depKeys.has(key)) {
        depKeys.add(key);
        dependencies.push(srcDep);
      }
    }

    const facts = analyzeScriptFile({
      text: paddedBlockSource(text, block),
      relPath,
      language: sourceLanguage,
      trackedSet
    });

    for (const symbol of facts.symbols) {
      const mapped = remapSymbol(symbol, relPath, sourceLanguage);
      if (symbolIds.has(mapped.symbol_id)) {
        return {
          status: "partial",
          symbols: [],
          dependencies: [],
          diagnostics: [{
            severity: "error",
            code: "vue_duplicate_symbol",
            message: "duplicate top-level Vue symbol: " + mapped.name
          }]
        };
      }
      symbolIds.add(mapped.symbol_id);
      symbols.push(mapped);
    }

    for (const dep of facts.dependencies) {
      const mapped = remapDependency(dep, relPath, sourceLanguage);
      if (mapped.relation === "calls" && COMPILER_MACROS.has(mapped.to_ref)) {
        continue;
      }
      const key = dependencyKey(mapped);
      if (depKeys.has(key)) continue;
      depKeys.add(key);
      dependencies.push(mapped);
    }
  }

  return { symbols, dependencies, diagnostics };
}

export function analyzeVueFiles({ items, trackedSet }) {
  return new Map(items.map((item) => [
    item.relPath,
    analyzeVueFile({
      text: item.text,
      relPath: item.relPath,
      trackedSet
    })
  ]));
}

export const VUE_ANALYZER_VERSION = compilerSfcVersion;
