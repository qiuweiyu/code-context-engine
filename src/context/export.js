import fs from "node:fs/promises";
import path from "node:path";

async function writeJsonlAtomic(filePath, records) {
  const tmp = `${filePath}.tmp`;
  const body = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, filePath);
}

export async function exportIndex(db, indexDir) {
  await fs.mkdir(indexDir, { recursive: true });
  const files = db.prepare("SELECT * FROM files ORDER BY path").all();
  const symbols = db.prepare("SELECT * FROM symbols ORDER BY file_path,line_start,symbol_id").all().map((row) => ({ ...row, params: JSON.parse(row.params_json), returns: JSON.parse(row.returns_json), params_json: undefined, returns_json: undefined }));
  const routes = db.prepare("SELECT * FROM routes ORDER BY file_path,line").all();
  const tables = db.prepare("SELECT * FROM db_objects ORDER BY object_name,file_path,line").all();
  const tests = db.prepare("SELECT * FROM tests ORDER BY test_file,target_file").all();
  const dependencies = db.prepare("SELECT * FROM dependencies ORDER BY from_file,from_symbol_id,to_ref").all();
  const changes = db.prepare("SELECT * FROM change_events ORDER BY id").all();
  const featureRows = db.prepare("SELECT * FROM features ORDER BY feature_id").all();
  const features = featureRows.map((feature) => {
    const steps = db.prepare(`SELECT fs.step_order AS step,fs.action,fs.symbol_id,COALESCE(s.file_path,fs.file_path) AS file_path,s.line_start,s.line_end,s.signature,s.params_json,s.returns_json,s.description AS symbol_description,s.implementation_hash,s.semantic_hash
      FROM feature_steps fs LEFT JOIN symbols s ON s.symbol_id=fs.symbol_id WHERE fs.feature_id=? ORDER BY fs.step_order`).all(feature.feature_id).map((step) => ({
        ...step,
        params: step.params_json ? JSON.parse(step.params_json) : [],
        returns: step.returns_json ? JSON.parse(step.returns_json) : [],
        params_json: undefined,
        returns_json: undefined
      }));
    const invariants = db.prepare("SELECT text FROM feature_invariants WHERE feature_id=? ORDER BY invariant_order").all(feature.feature_id).map((r)=>r.text);
    return { ...feature, steps, invariants };
  });
  await Promise.all([
    writeJsonlAtomic(path.join(indexDir, "files.jsonl"), files),
    writeJsonlAtomic(path.join(indexDir, "symbols.jsonl"), symbols),
    writeJsonlAtomic(path.join(indexDir, "features.jsonl"), features),
    writeJsonlAtomic(path.join(indexDir, "routes.jsonl"), routes),
    writeJsonlAtomic(path.join(indexDir, "tables.jsonl"), tables),
    writeJsonlAtomic(path.join(indexDir, "tests.jsonl"), tests),
    writeJsonlAtomic(path.join(indexDir, "dependencies.jsonl"), dependencies),
    writeJsonlAtomic(path.join(indexDir, "changes.jsonl"), changes)
  ]);
  const manifest = {
    schema_version: Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value ?? 0),
    indexed_at: db.prepare("SELECT value FROM meta WHERE key='last_indexed_at'").get()?.value ?? null,
    counts: {
      files: db.prepare("SELECT COUNT(*) AS n FROM files").get().n,
      symbols: symbols.length,
      features: features.length,
      routes: routes.length,
      db_objects: tables.length,
      tests: tests.length,
      dependencies: dependencies.length
    },
    feature_status: {
      valid: features.filter((x)=>x.status === "valid").length,
      needs_review: features.filter((x)=>x.status === "needs_review").length,
      stale: features.filter((x)=>x.status === "stale").length
    }
  };
  await fs.writeFile(path.join(indexDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}
