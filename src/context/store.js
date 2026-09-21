import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export function openStore(indexDir) {
  fs.mkdirSync(indexDir, { recursive: true });
  const dbPath = path.join(indexDir, "index.sqlite");
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec(SCHEMA_SQL);
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
