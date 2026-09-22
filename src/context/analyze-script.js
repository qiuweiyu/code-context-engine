import { sha256Text, hashObject } from "./hash.js";
import { lineOf, resolveRelativeImport } from "./utils.js";

function stripVue(text) {
  const match = text.match(/<script(?:\s+setup)?[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return { script: text, offset: 0 };
  const start = match.index + match[0].indexOf(match[1]);
  return { script: match[1], offset: start };
}

function findBlockEnd(text, bodyStart) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = bodyStart; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (blockComment) { if (ch === "*" && next === "/") { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function precedingComment(text, start) {
  const prefix = text.slice(Math.max(0, start - 800), start);
  const jsdoc = prefix.match(/\/\*\*([\s\S]*?)\*\/\s*$/);
  if (jsdoc) return jsdoc[1].split("\n").map((line) => line.replace(/^\s*\*?\s?/, "")).join(" ").replace(/\s+/g, " ").trim();
  const lines = prefix.split("\n");
  const comments = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("//")) comments.unshift(line.slice(2).trim());
    else if (line === "") continue;
    else break;
  }
  return comments.join(" ").trim();
}

function parseParams(raw) {
  if (!raw.trim()) return [];
  return raw.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const clean = part.replace(/^\.\.\./, "");
    const colon = clean.indexOf(":");
    const eq = clean.indexOf("=");
    const namePart = clean.slice(0, colon >= 0 ? colon : (eq >= 0 ? eq : clean.length)).trim();
    const typePart = colon >= 0 ? clean.slice(colon + 1, eq >= 0 ? eq : clean.length).trim() : "";
    return { name: namePart.replace(/[?]/g, ""), type: typePart || null };
  });
}

function extractCalls(body) {
  const out = [];
  const seen = new Set();
  const regex = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
  const skip = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new"]);
  for (const match of body.matchAll(regex)) {
    const call = match[1];
    if (skip.has(call) || seen.has(call)) continue;
    seen.add(call);
    out.push(call);
    if (out.length >= 80) break;
  }
  return out;
}

function parseImportBindings(clause) {
  const value = String(clause ?? "").trim().replace(/^type\s+/, "");
  const bindings = [];
  if (!value) return bindings;

  const named = value.match(/\{([\s\S]*?)\}/);
  if (named) {
    for (const rawPart of named[1].split(",")) {
      const part = rawPart.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const match = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!match) continue;
      bindings.push({ kind: "named", imported: match[1], local: match[2] ?? match[1] });
    }
  }

  const namespace = value.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespace) bindings.push({ kind: "namespace", imported: "*", local: namespace[1] });

  const withoutNamed = value.replace(/\{[\s\S]*?\}/, "").replace(/,?\s*\*\s+as\s+[A-Za-z_$][\w$]*/, "").trim();
  const defaultMatch = withoutNamed.match(/^([A-Za-z_$][\w$]*)/);
  if (defaultMatch) bindings.push({ kind: "default", imported: "default", local: defaultMatch[1] });

  return bindings;
}

function extractImports(source, relPath, trackedSet) {
  const out = [];
  const seen = new Set();

  const fromImport = /\bimport\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(fromImport)) {
    const toRef = match[2];
    const key = `from:${match.index}:${toRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      from_file: relPath,
      from_symbol_id: null,
      relation: "imports",
      to_ref: toRef,
      to_file: resolveRelativeImport(relPath, toRef, trackedSet),
      resolved_symbol_id: null,
      metadata: {
        import_kind: "from",
        import_bindings: parseImportBindings(match[1])
      }
    });
  }

  const sideEffectImport = /\bimport\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(sideEffectImport)) {
    const toRef = match[1];
    const key = `side:${match.index}:${toRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      from_file: relPath,
      from_symbol_id: null,
      relation: "imports",
      to_ref: toRef,
      to_file: resolveRelativeImport(relPath, toRef, trackedSet),
      resolved_symbol_id: null,
      metadata: { import_kind: "side_effect", import_bindings: [] }
    });
  }

  return out;
}

export function analyzeScriptFile({ text, relPath, language, trackedSet }) {
  const vue = language === "vue" ? stripVue(text) : { script: text, offset: 0 };
  const source = vue.script;
  const symbols = [];
  const dependencies = [];
  const moduleId = `${language}:${relPath}`;

  dependencies.push(...extractImports(source, relPath, trackedSet));

  const declarations = [];
  const patterns = [
    { kind: "function", regex: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^\{=\n]+?))?\s*\{/g },
    { kind: "function", regex: /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*([^=\n]+?))?=>\s*\{/g },
    { kind: "function", regex: /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>\s*\{/g, singleParam: true }
  ];
  for (const spec of patterns) {
    for (const match of source.matchAll(spec.regex)) {
      const absoluteStart = vue.offset + (match.index ?? 0);
      const braceInMatch = match[0].lastIndexOf("{");
      const bodyStart = (match.index ?? 0) + braceInMatch;
      const end = findBlockEnd(source, bodyStart);
      declarations.push({
        name: match[1],
        paramsRaw: spec.singleParam ? match[2] : (match[2] ?? ""),
        returnRaw: spec.singleParam ? "" : (match[3] ?? ""),
        kind: spec.kind,
        localStart: match.index ?? 0,
        localBodyStart: bodyStart,
        localEnd: end,
        absoluteStart,
        absoluteEnd: vue.offset + end,
        signature: match[0].slice(0, Math.max(0, braceInMatch)).replace(/\s+/g, " ").trim()
      });
    }
  }

  declarations.sort((a, b) => a.absoluteStart - b.absoluteStart);
  const unique = new Set();
  for (const decl of declarations) {
    const key = `${decl.name}:${decl.absoluteStart}`;
    if (unique.has(key)) continue;
    unique.add(key);
    const body = source.slice(decl.localBodyStart, decl.localEnd);
    const params = parseParams(decl.paramsRaw);
    const returns = decl.returnRaw.trim() ? [{ type: decl.returnRaw.trim() }] : [];
    const comment = precedingComment(source, decl.localStart);
    const calls = extractCalls(body);
    const description = comment || `${decl.name}(${params.map((p) => p.name).join(", ")}) in ${relPath}${calls.length ? `; calls ${calls.slice(0, 8).join(", ")}` : ""}.`;
    const line_start = lineOf(text, decl.absoluteStart);
    const line_end = lineOf(text, decl.absoluteEnd);
    const symbol_id = `${moduleId}::${decl.name}`;
    const semantic = { name: decl.name, kind: decl.kind, signature: decl.signature, params, returns, description, calls };
    const implementation_hash = sha256Text(text.slice(decl.absoluteStart, decl.absoluteEnd));
    symbols.push({
      symbol_id,
      file_path: relPath,
      language,
      name: decl.name,
      qualified_name: decl.name,
      kind: decl.kind,
      receiver: null,
      signature: decl.signature,
      params,
      returns,
      description,
      description_source: comment ? "comment" : "derived",
      line_start,
      line_end,
      implementation_hash,
      semantic_hash: hashObject(semantic),
      calls
    });
  }

  for (const symbol of symbols) {
    for (const call of symbol.calls) dependencies.push({ from_file: relPath, from_symbol_id: symbol.symbol_id, relation: "calls", to_ref: call, to_file: null, resolved_symbol_id: null });
  }
  return { symbols, dependencies };
}
