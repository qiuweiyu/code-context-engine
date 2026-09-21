import path from "node:path";

const STOP = new Set([
  "this", "that", "with", "from", "into", "when", "where", "what", "which", "then", "than",
  "need", "make", "change", "update", "fix", "task", "file", "code", "test", "tests", "project",
  "the", "and", "for", "are", "not", "you", "your", "use", "using"
]);

export function tokenize(text) {
  const raw = String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.:/\-]+/g, " ")
    .match(/[p{L}p{N}]{2,}/gu) ?? [];
  const expanded = [];
  for (const token of raw.map((x) => x.toLowerCase())) {
    if (STOP.has(token) || token.length < 2) continue;
    expanded.push(token);
    if (/p{Script=Han}/u.test(token)) {
      const chars = [...token];
      for (let i = 0; i < chars.length - 1; i++) expanded.push(chars[i] + chars[i + 1]);
    }
  }
  return [...new Set(expanded)];
}

export function lexicalScore({ relPath, preview = "", changed = false }, terms) {
  const p = relPath.toLowerCase();
  const body = preview.toLowerCase();
  let score = changed ? 6 : 0;
  for (const term of terms) {
    if (p.includes(term)) score += 8;
    const idx = body.indexOf(term);
    if (idx >= 0) score += 2;
    if (idx >= 0 && body.indexOf(term, idx + term.length) >= 0) score += 1;
  }
  const base = path.posix.basename(relPath.replaceAll("\\", "/")).toLowerCase();
  if (/test|spec|acceptance/.test(base)) score += terms.some((t) => /test|accept|验收|测试/.test(t)) ? 3 : 0;
  return score;
}

export function rankLexically(candidates, task, hints = []) {
  const terms = tokenize([task, ...hints].join(" "));
  return candidates
    .map((candidate, index) => ({ ...candidate, lexical_score: lexicalScore(candidate, terms), _index: index }))
    .sort((a, b) => b.lexical_score - a.lexical_score || a._index - b._index)
    .map(({ _index, ...rest }) => rest);
}

export function classifyScore(probability, mustReadAt, maybeReadAt) {
  if (probability >= mustReadAt) return "must_read";
  if (probability >= maybeReadAt) return "maybe_read";
  return "skip";
}
