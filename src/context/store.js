import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { rebuildDependencyEdges, rebuildRouteHandlerEdges } from "./edges.js";

function readSchemaVersion(db) {
  const hasMeta = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!hasMeta) return 0;
  const value = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
  return Number(value ?? 0);
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function migrateSchema(db, previousVersion) {
  if (previousVersion < 4) rebuildDependencyEdges(db);
  if (previousVersion < 5) {
    if (!hasColumn(db, "routes", "handler_ref")) db.exec("ALTER TABLE routes ADD COLUMN handler_ref TEXT");
    if (!hasColumn(db, "routes", "handler_symbol_id")) db.exec("ALTER TABLE routes ADD COLUMN handler_symbol_id TEXT");
    rebuildRouteHandlerEdges(db);
  }
}

export function openStore(indexDir) {
  fs.mkdirSync(indexDir, { recursive: true });
  const dbPath = path.join(indexDir, "index.sqlite");
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  const previousVersion = readSchemaVersion(db);

  if (previousVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error(`index schema ${previousVersion} is newer than supported schema ${SCHEMA_VERSION}`);
  }

  db.exec(SCHEMA_SQL);
  migrateSchema(db, previousVersion);
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run("schema_version", String(SCHEMA_VERSION));
  return { db, dbPath };
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function rows(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function row(db, sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}
