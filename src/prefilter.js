import path from "node:path";

const STOP = new Set([
  "this", "that", "with", "from", "into", "when", "where", "what", "which", "then", "than",
  "need", "make", "change", "update", "fix", "task", "file", "code", "test", "tests", "project",
  "the", "and", "for", "are", "not", "you", "your", "use", "using"
]);

export const BUILTIN_QUERY_ALIASES = Object.freeze({
  "管理端": ["admin", "adminweb", "console"],
  "后台": ["admin", "backend"],
  "小程序": ["miniprogram", "mini_program", "wechat", "wx"],
  "人工任务": ["manualtask", "manual_task", "manual task"],
  "人工": ["manual"],
  "任务": ["task"],
  "显示": ["display", "render", "show", "list"],
  "列表": ["list"],
  "学生": ["student"],
  "家长": ["parent"],
  "老师": ["teacher"],
  "班级": ["class"],
  "发布": ["publish"],
  "未发布": ["draft", "unpublished"],
  "创建": ["create"],
  "编辑": ["edit", "update"],
  "更新": ["update"],
  "删除": ["delete", "remove"],
  "查询": ["query", "search", "list"],
  "获取": ["get", "fetch", "load"],
  "录音": ["recording", "audio"],
  "音频": ["audio"],
  "发音": ["pronunciation"],
  "评测": ["assessment", "evaluate", "score"],
  "内容库": ["contentlibrary", "content_library", "content"],
  "二维码": ["qrcode", "qr"]
});

function rawTerms(text) {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.:/\\-]+/g, " ")
    .match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

function addAliasValue(target, value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw.length < 2) return;
  target.add(raw);
  const compact = raw.replace(/[\s_.:/\\-]+/g, "");
  if (compact.length >= 2) target.add(compact);
  for (const token of rawTerms(raw).map((x) => x.toLowerCase())) {
    if (token.length >= 2) target.add(token);
  }
}

function normalizedAliasValues(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null) return [];
  return [String(value)];
}

export function expandQuery(text, customAliases = {}) {
  const source = String(text ?? "");
  const sourceLower = source.toLowerCase();
  const terms = new Set();
  const appliedAliases = [];

  for (const token of rawTerms(source).map((x) => x.toLowerCase())) {
    if (STOP.has(token) || token.length < 2) continue;
    terms.add(token);
    if (/\p{Script=Han}/u.test(token)) {
      const chars = [...token];
      for (let i = 0; i < chars.length - 1; i++) terms.add(chars[i] + chars[i + 1]);
    }
  }

  const applyTable = (table, sourceName) => {
    for (const [key, value] of Object.entries(table ?? {})) {
      const matchKey = String(key).trim().toLowerCase();
      if (!matchKey || !sourceLower.includes(matchKey)) continue;
      const aliases = normalizedAliasValues(value);
      for (const alias of aliases) addAliasValue(terms, alias);
      appliedAliases.push({ source: sourceName, key, aliases });
    }
  };

  applyTable(BUILTIN_QUERY_ALIASES, "builtin");
  applyTable(customAliases, "project");

  return { terms: [...terms], applied_aliases: appliedAliases };
}

export function tokenize(text, customAliases = {}) {
  return expandQuery(text, customAliases).terms;
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
