import { lineOf, nearestSymbol } from "./utils.js";
import { extractClientRoutes } from "./client-requests.js";

const SQL_PATTERNS = [
  ["table", "select", /\bSELECT\b[\s\S]{0,300}?\bFROM\s+["'`]?([A-Za-z_][\w.$-]*)/gi],
  ["table", "join", /\bSELECT\b[\s\S]{0,500}?\bJOIN\s+["'`]?([A-Za-z_][\w.$-]*)/gi],
  ["table", "insert", /\bINSERT\s+INTO\s+["'`]?([A-Za-z_][\w.$-]*)/gi],
  ["table", "update", /\bUPDATE\s+["'`]?([A-Za-z_][\w.$-]*)["'`]?\s+SET\b/gi],
  ["table", "delete", /\bDELETE\s+FROM\s+["'`]?([A-Za-z_][\w.$-]*)/gi],
  ["table", "create", /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][\w.$-]*)/gi],
  ["table", "alter", /\bALTER\s+TABLE\s+["'`]?([A-Za-z_][\w.$-]*)/gi]
];

export function extractDbObjects(text, filePath, symbols = []) {
  const out = [];
  const seen = new Set();
  for (const [object_type, operation, regex] of SQL_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const object_name = match[1].replace(/[;,)]$/, "");
      const line = lineOf(text, match.index ?? 0);
      const key = `${operation}:${object_name}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file_path: filePath, symbol_id: nearestSymbol(symbols, line), object_type, object_name, operation, line });
    }
  }
  return out;
}

function handlerReference(expression) {
  const value = String(expression ?? "");
  const wrapped = value.match(/\bHandlerFunc\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/);
  if (wrapped) return wrapped[1];

  const direct = value.trim().match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\b/);
  return direct?.[1] ?? null;
}

function methodReceiverOwnerType(text, symbol, handlerRef) {
  if (!symbol?.receiver || !handlerRef?.includes(".")) return null;
  const root = String(handlerRef).split(".")[0];
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, Number(symbol.line_start ?? 1) - 1);
  const header = lines.slice(start, start + 4).join("\n").split("{", 1)[0];
  const match = header.match(/\bfunc\s*\(\s*([A-Za-z_$][\w$]*)\s+[^)]+\)\s*[A-Za-z_$][\w$]*\s*\(/);
  if (!match || match[1] !== root) return null;
  return symbol.receiver;
}

function addRoute(out, seen, text, filePath, symbols, route) {
  const routePath = String(route.route_path ?? "");
  if (!routePath || (!routePath.startsWith("/") && !routePath.startsWith("http"))) return;
  const line = lineOf(text, route.index ?? 0);
  const method = String(route.method ?? "ANY").toUpperCase();
  const direction = route.direction;
  const key = `${direction}:${method}:${routePath}:${line}`;
  if (seen.has(key)) return;
  seen.add(key);
  const symbolId = nearestSymbol(symbols, line);
  const ownerSymbol = symbolId ? symbols.find((symbol) => symbol.symbol_id === symbolId) : null;
  out.push({
    file_path: filePath,
    symbol_id: symbolId,
    method,
    route_path: routePath,
    direction,
    line,
    handler_ref: route.handler_ref ?? null,
    handler_owner_type: methodReceiverOwnerType(text, ownerSymbol, route.handler_ref ?? null)
  });
}

export function extractRoutes(text, filePath, symbols = []) {
  const out = extractClientRoutes(text, filePath, symbols);
  const seen = new Set(out.map((route) => `${route.direction}:${route.method}:${route.route_path}:${route.line}`));

  // Go/custom-router style:
  // router.Handle(http.MethodGet, "/path", wrapper(http.HandlerFunc(api.List)))
  // router.HandlePattern(http.MethodPost, "/path/{id}", http.HandlerFunc(api.Update))
  const handlePattern = /\b(?:[A-Za-z_$][\w$]*\.)?(?:Handle|HandlePattern)\s*\(\s*(?:http\.)?Method(Get|Post|Put|Patch|Delete|Options|Head)\s*,\s*["'`]([^"'`]+)["'`]\s*,([\s\S]{0,1200}?)(?=\)\s*(?:;|\r?\n|$))/g;
  for (const match of text.matchAll(handlePattern)) {
    addRoute(out, seen, text, filePath, symbols, {
      index: match.index,
      direction: "server",
      method: match[1],
      route_path: match[2],
      handler_ref: handlerReference(match[3])
    });
  }

  // Common router style: router.GET("/path", api.List)
  const methodHandlerPattern = /\.((?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD))\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/gi;
  for (const match of text.matchAll(methodHandlerPattern)) {
    addRoute(out, seen, text, filePath, symbols, {
      index: match.index,
      direction: "server",
      method: match[1],
      route_path: match[2],
      handler_ref: match[3]
    });
  }

  const patterns = [
    ["server", /\b(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*["'`]([^"'`]+)["'`]/g, null],
    ["server", /\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*["'`]([^"'`]+)["'`]/gi, 1],
  ];
  for (const [direction, regex, methodGroup] of patterns) {
    for (const match of text.matchAll(regex)) {
      let method = "ANY";
      let routePath = "";
      if (methodGroup === 1) {
        method = String(match[1]).toUpperCase();
        routePath = match[2];
      } else {
        routePath = match[1];
        const prefix = match[0].match(/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/i)?.[1];
        if (prefix) method = prefix.toUpperCase();
      }
      addRoute(out, seen, text, filePath, symbols, {
        index: match.index,
        direction,
        method,
        route_path: routePath,
        handler_ref: null
      });
    }
  }
  return out;
}

function commentRanges(text) {
  const ranges = [];
  let index = 0;
  let quote = null;
  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1];
    if (quote) {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === quote) quote = null;
      index++;
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      index++;
      continue;
    }
    if (current === "/" && next === "/") {
      const start = index;
      index += 2;
      while (index < text.length && text[index] !== "\n") index++;
      ranges.push([start, index]);
      continue;
    }
    if (current === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++;
      index = Math.min(text.length, index + 2);
      ranges.push([start, index]);
      continue;
    }
    index++;
  }
  return ranges;
}

function insideRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function entryNodeId(kind, filePath, name, line) {
  return "entry:" + kind + ":" + filePath + ":" + encodeURIComponent(name) + ":" + line;
}

function addEntry(out, seen, text, filePath, symbols, ranges, entry) {
  const index = entry.index ?? 0;
  if (insideRanges(index, ranges)) return;
  const line = entry.line ?? lineOf(text, index);
  const handlerRef = handlerReference(entry.handler_ref);
  if (!handlerRef) return;
  const key = [entry.kind, entry.name, handlerRef, line].join("|");
  if (seen.has(key)) return;
  seen.add(key);
  out.push({
    node_id: entryNodeId(entry.kind, filePath, entry.name, line),
    file_path: filePath,
    symbol_id: entry.symbol_id ?? nearestSymbol(symbols, line),
    entry_kind: entry.kind,
    entry_name: entry.name,
    line,
    handler_ref: handlerRef,
    handler_symbol_id: entry.handler_symbol_id ?? null,
    metadata: entry.metadata ?? {}
  });
}

export function extractEntryPoints(
  text,
  filePath,
  symbols = [],
  { language = "", packageName = null } = {}
) {
  const out = [];
  const seen = new Set();
  const ranges = commentRanges(text);

  if (language === "go" && packageName === "main") {
    for (const symbol of symbols) {
      if (symbol.kind !== "function" || symbol.name !== "main") continue;
      addEntry(out, seen, text, filePath, symbols, ranges, {
        kind: "cli",
        name: "main",
        line: symbol.line_start,
        symbol_id: symbol.symbol_id,
        handler_ref: "main",
        handler_symbol_id: symbol.symbol_id,
        metadata: { registration: "go_package_main" }
      });
    }
  }

  if ((language === "typescript" || language === "javascript")
      && /^#!.*\bnode\b/m.test(text)) {
    for (const symbol of symbols) {
      if (symbol.kind !== "function" || symbol.name !== "main") continue;
      addEntry(out, seen, text, filePath, symbols, ranges, {
        kind: "cli",
        name: "main",
        line: symbol.line_start,
        symbol_id: symbol.symbol_id,
        handler_ref: "main",
        handler_symbol_id: symbol.symbol_id,
        metadata: { registration: "node_shebang_main" }
      });
    }
  }

  const registrations = [
    {
      kind: "job",
      registration: "cron",
      regex: /\.(AddFunc|AddJob|schedule)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g
    },
    {
      kind: "job",
      registration: "schedule_job",
      regex: /\bscheduleJob\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g,
      methodGroup: null
    },
    {
      kind: "consumer",
      registration: "message_consumer",
      regex: /\.(Subscribe|Consume|Process|subscribe|consume|process)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g
    }
  ];

  for (const spec of registrations) {
    for (const match of text.matchAll(spec.regex)) {
      if (insideRanges(match.index ?? 0, ranges)) continue;
      let name;
      let handler;
      let method;
      if (spec.registration === "schedule_job") {
        name = match[1];
        handler = match[2];
        method = "scheduleJob";
      } else {
        method = match[1];
        name = match[2];
        handler = match[3];
      }
      addEntry(out, seen, text, filePath, symbols, ranges, {
        index: match.index,
        kind: spec.kind,
        name,
        handler_ref: handler,
        metadata: {
          registration: spec.registration,
          method
        }
      });
    }
  }

  return out;
}
