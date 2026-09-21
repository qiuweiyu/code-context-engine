import path from "node:path";
import { openStore } from "./store.js";

export function readIndexStatus({ repoRoot, indexDir = ".context-index" }) {
  const dir = path.isAbsolute(indexDir) ? indexDir : path.join(repoRoot, indexDir);
  const { db, dbPath } = openStore(dir);
  try {
    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    return {
      ok: true,
      database: dbPath,
      indexed_at: db.prepare("SELECT value FROM meta WHERE key='last_indexed_at'").get()?.value ?? null,
      repository: db.prepare("SELECT value FROM meta WHERE key='repository_root'").get()?.value ?? repoRoot,
      counts: {
        files: count("files"), symbols: count("symbols"), features: count("features"), dependencies: count("dependencies"), routes: count("routes"), db_objects: count("db_objects"), tests: count("tests")
      },
      features: db.prepare("SELECT feature_id,name,status,needs_review,stale_reason,generated_hash,reviewed_at FROM features ORDER BY feature_id").all()
    };
  } finally { db.close(); }
}
