import { lineOf, nearestSymbol } from "./utils.js";

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

export function extractRoutes(text, filePath, symbols = []) {
  const out = [];
  const seen = new Set();
  const patterns = [
    ["server", /\b(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*["'`]([^"'`]+)["'`]/g, null],
    ["server", /\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*["'`]([^"'`]+)["'`]/gi, 1],
    ["client", /\b(?:fetch|request)\s*\(\s*["'`]([^"'`]+)["'`]/gi, null],
    ["client", /\baxios\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi, 1],
    ["client", /\burl\s*:\s*["'`]([^"'`]+)["'`]/gi, null]
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
      if (!routePath || (!routePath.startsWith("/") && !routePath.startsWith("http"))) continue;
      const line = lineOf(text, match.index ?? 0);
      const key = `${direction}:${method}:${routePath}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file_path: filePath, symbol_id: nearestSymbol(symbols, line), method, route_path: routePath, direction, line });
    }
  }
  return out;
}
