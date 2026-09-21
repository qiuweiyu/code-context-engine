import path from "node:path";

export function normalizeRel(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function lineOf(text, offset) {
  if (offset <= 0) return 1;
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function nearestSymbol(symbols, line) {
  let best = null;
  for (const symbol of symbols) {
    if (line >= symbol.line_start && line <= symbol.line_end) return symbol.symbol_id;
    if (symbol.line_start <= line && (!best || symbol.line_start > best.line_start)) best = symbol;
  }
  return best?.symbol_id ?? null;
}

export function resolveRelativeImport(fromFile, specifier, trackedSet) {
  if (!specifier?.startsWith(".")) return null;
  const base = normalizeRel(path.posix.normalize(path.posix.join(path.posix.dirname(normalizeRel(fromFile)), specifier)));
  const attempts = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.vue`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.vue`
  ];
  return attempts.find((candidate) => trackedSet.has(candidate)) ?? null;
}
