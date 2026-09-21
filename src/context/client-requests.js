import { lineOf, nearestSymbol } from "./utils.js";

function staticStringConstants(text) {
  const out = new Map();
  const regex = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'\x60])([^"'\x60\r\n]*?)\2/g;
  for (const match of text.matchAll(regex)) {
    if (match[3].includes("${")) continue;
    out.set(match[1], match[3]);
  }
  return out;
}

function normalizeClientPath(rawLiteral, constants) {
  if (!rawLiteral || rawLiteral.length < 2) return null;
  const quote = rawLiteral[0];
  let value = rawLiteral.slice(1, -1);

  if (quote.charCodeAt(0) === 96) {
    value = value.replace(/\$\{([^}]+)\}/g, (_all, expression) => {
      const key = String(expression).trim();
      if (constants.has(key)) return constants.get(key);
      return "{param}";
    });
  }

  value = value.split("#", 1)[0].split("?", 1)[0];
  if (/^https?:\/\//i.test(value)) {
    try { value = new URL(value).pathname; }
    catch { return null; }
  }
  if (!value.startsWith("/")) return null;
  return value.replace(/\/{2,}/g, "/");
}

function findCallEnd(text, openParen) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = openParen; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch.charCodeAt(0) === 96) {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return Math.min(text.length, openParen + 1200);
}

function requestMethod(callee, callText) {
  const axios = String(callee).match(/\.(get|post|put|patch|delete|options|head)$/i);
  if (axios) return axios[1].toUpperCase();

  const explicit = String(callText).match(
    /\bmethod\s*:\s*["'](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)["']/i
  );
  if (explicit) return explicit[1].toUpperCase();

  return String(callee).toLowerCase() === "fetch" ? "GET" : "ANY";
}

function requestLikeCallee(callee) {
  const value = String(callee);
  const tail = value.split(".").at(-1)?.toLowerCase() ?? "";
  return tail === "fetch"
    || tail === "request"
    || tail.includes("request")
    || /^axios\.(get|post|put|patch|delete|options|head)$/i.test(value);
}

function routeFact(text, filePath, symbols, index, method, routePath) {
  const line = lineOf(text, index ?? 0);
  return {
    file_path: filePath,
    symbol_id: nearestSymbol(symbols, line),
    method: String(method ?? "ANY").toUpperCase(),
    route_path: routePath,
    direction: "client",
    line,
    handler_ref: null,
    handler_owner_type: null
  };
}

export function extractClientRoutes(text, filePath, symbols = []) {
  const out = [];
  const seen = new Set();
  const constants = staticStringConstants(text);

  const requestCall = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:<[^>\r\n]+>)?\s*\(\s*(\x60(?:\\.|[^\x60])*\x60|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')/g;
  for (const match of text.matchAll(requestCall)) {
    const callee = match[1];
    if (!requestLikeCallee(callee)) continue;

    const routePath = normalizeClientPath(match[2], constants);
    if (!routePath) continue;

    const openParen = (match.index ?? 0) + match[0].indexOf("(");
    const end = findCallEnd(text, openParen);
    const method = requestMethod(callee, text.slice(openParen, end));
    const fact = routeFact(text, filePath, symbols, match.index ?? 0, method, routePath);
    const key = fact.method + ":" + fact.route_path + ":" + fact.line;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }

  const urlProperty = /\burl\s*:\s*(\x60(?:\\.|[^\x60])*\x60|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')/gi;
  for (const match of text.matchAll(urlProperty)) {
    const routePath = normalizeClientPath(match[1], constants);
    if (!routePath) continue;

    const tail = text.slice(match.index ?? 0, (match.index ?? 0) + 600);
    const fact = routeFact(
      text,
      filePath,
      symbols,
      match.index ?? 0,
      requestMethod("request", tail),
      routePath
    );
    const key = fact.method + ":" + fact.route_path + ":" + fact.line;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }

  return out;
}
