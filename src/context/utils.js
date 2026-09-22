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
  const from = normalizeRel(fromFile);
  const raw = String(specifier ?? "");
  let base = null;

  if (raw.startsWith(".")) {
    base = normalizeRel(path.posix.normalize(path.posix.join(path.posix.dirname(from), raw)));
  } else if (raw.startsWith("@/")) {
    const srcMarker = "/src/";
    const markerIndex = from.lastIndexOf(srcMarker);
    if (markerIndex >= 0) {
      base = from.slice(0, markerIndex + srcMarker.length) + raw.slice(2);
    } else if (from.startsWith("src/")) {
      base = "src/" + raw.slice(2);
    }
  }

  if (!base) return null;
  const attempts = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.vue`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.vue`
  ];
  return attempts.find((candidate) => trackedSet.has(candidate)) ?? null;
}
