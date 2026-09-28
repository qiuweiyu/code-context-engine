import http from "node:http";
import fs from "node:fs";
import { openTelemetryStore, TELEMETRY_STORE_VERSION } from "./store.js";
import { runtimeIdentity } from "../runtime.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const UI_ASSETS = new Map([
  ["/", ["./ui/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["./ui/app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["./ui/styles.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["./ui/favicon.svg", "image/svg+xml"]]
]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": CSP
};

function reply(res, status, body) {
  const content = JSON.stringify(body);
  res.writeHead(status, {
    ...JSON_HEADERS,
    "Content-Length": Buffer.byteLength(content, "utf8")
  });
  res.end(content);
}

function replyAsset(res, route) {
  const [relPath, contentType] = UI_ASSETS.get(route);
  const body = fs.readFileSync(new URL(relPath, import.meta.url));
  res.writeHead(200, {
    ...JSON_HEADERS,
    "Content-Type": contentType,
    "Content-Length": body.length
  });
  res.end(body);
}

function badInput() {
  const error = new Error("invalid request");
  error.statusCode = 400;
  return error;
}

function parseCursor(raw) {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(raw)) throw badInput();
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    throw badInput();
  }
}

function exactQuery(params, allowed) {
  for (const [key] of params) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw badInput();
  }
}

function router(req, res, { store, port, runtime, clock }) {
  const expectedHost = `${HOST}:${port}`;
  if (req.headers.host?.toLowerCase() !== expectedHost) {
    reply(res, 403, { ok: false, error: "invalid_host" });
    return;
  }
  const expectedOrigin = `http://${expectedHost}`;
  if (req.headers.origin && req.headers.origin !== expectedOrigin) {
    reply(res, 403, { ok: false, error: "invalid_origin" });
    return;
  }
  if (req.method !== "GET") {
    reply(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] ?? 0) > 0) {
    reply(res, 400, { ok: false, error: "invalid_request" });
    return;
  }

  try {
    const url = new URL(req.url, expectedOrigin);
    const route = url.pathname;
    const noParams = () => exactQuery(url.searchParams, new Set());
    if (UI_ASSETS.has(route)) {
      noParams();
      replyAsset(res, route);
    } else if (route === "/status") {
      noParams();
      reply(res, 200, {
        ok: true, service: "cce-observability", state: "online",
        runtime: {
          package_version: runtime.package_version,
          runtime_git_head: runtime.runtime_git_head,
          runtime_fingerprint: runtime.runtime_fingerprint
        },
        telemetry: {
          schema_version: TELEMETRY_STORE_VERSION,
          capture: "inactive",
          ...store.getSettings()
        },
        listen: { host: HOST, port },
        active_repository: null,
        index_freshness: "unavailable",
        client_identity: "unavailable"
      });
    } else if (route === "/requests") {
      exactQuery(url.searchParams, new Set(["limit", "cursor"]));
      const rawLimit = url.searchParams.get("limit");
      if (rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit)) throw badInput();
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      const rawCursor = url.searchParams.get("cursor");
      const before = rawCursor === null ? null : parseCursor(rawCursor);
      const page = store.listRequests({ limit, before });
      reply(res, 200, {
        ok: true, requests: page.requests,
        next_cursor: page.next_cursor
          ? Buffer.from(JSON.stringify(page.next_cursor), "utf8").toString("base64url")
          : null
      });
    } else if (route.startsWith("/requests/")) {
      noParams();
      const id = route.slice("/requests/".length);
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
        throw badInput();
      }
      const request = store.getRequest(id);
      reply(res, request ? 200 : 404,
        request ? { ok: true, request } : { ok: false, error: "not_found" });
    } else if (route === "/metrics") {
      noParams();
      const now = clock();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error("invalid clock");
      }
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      reply(res, 200, {
        ok: true, window: "last_24h", ...store.getMetrics({ since })
      });
    } else if (route === "/effects") {
      noParams();
      reply(res, 200, {
        ok: true, status: "unavailable",
        reason: "measurement_not_implemented",
        measurements: []
      });
    } else {
      reply(res, 404, { ok: false, error: "not_found" });
    }
  } catch (error) {
    reply(res, error.statusCode === 400 || error.name === "ZodError" || error instanceof RangeError
      ? 400 : 500, {
      ok: false,
      error: error.statusCode === 400 || error.name === "ZodError" || error instanceof RangeError
        ? "invalid_request" : "internal_error"
    });
  }
}

export async function startObservabilityApi({
  host = HOST,
  port = DEFAULT_PORT,
  store = null,
  directory,
  clock = () => new Date()
} = {}) {
  if (host !== HOST) throw new RangeError("observability API only binds 127.0.0.1");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const owned = store === null;
  const localStore = store ?? openTelemetryStore({ directory });
  const runtime = runtimeIdentity();
  let actualPort;
  const server = http.createServer((req, res) =>
    router(req, res, { store: localStore, port: actualPort, runtime, clock }));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    actualPort = server.address().port;
  } catch (error) {
    if (owned) localStore.close();
    throw error;
  }

  let closed = false;
  return {
    url: `http://${HOST}:${actualPort}`,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await new Promise((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()));
      } finally {
        if (owned) localStore.close();
      }
    }
  };
}
