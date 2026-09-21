import fs from "node:fs/promises";
import path from "node:path";
import { hashObject } from "./hash.js";
import { transaction } from "./store.js";

function validDefinition(value, filePath) {
  if (!value || typeof value !== "object") throw new Error(`Invalid feature definition: ${filePath}`);
  if (!value.id || !value.name || !value.description) throw new Error(`Feature requires id/name/description: ${filePath}`);
  if (!Array.isArray(value.steps)) value.steps = [];
  if (!Array.isArray(value.invariants)) value.invariants = [];
  return value;
}

export async function loadFeatureDefinitions(repoRoot) {
  const dir = path.join(repoRoot, ".context-features");
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const out = [];
  for (const entry of entries.filter((x) => x.isFile() && x.name.endsWith(".json")).sort((a,b)=>a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const raw = await fs.readFile(full, "utf8");
    const def = validDefinition(JSON.parse(raw), full);
    out.push({ definition_path: `.context-features/${entry.name}`, definition_hash: hashObject(def), definition: def });
  }
  return out;
}

export function syncFeatureDefinitions(db, definitions, now) {
  const seen = new Set();
  transaction(db, () => {
    for (const item of definitions) {
      const def = item.definition;
      seen.add(def.id);
      const existing = db.prepare("SELECT definition_hash FROM features WHERE feature_id=?").get(def.id);
      const changed = !existing || existing.definition_hash !== item.definition_hash;
      db.prepare(`INSERT INTO features(feature_id,name,description,definition_path,definition_hash,status,needs_review,stale_reason,updated_at)
        VALUES(?,?,?,?,?,'valid',0,NULL,?)
        ON CONFLICT(feature_id) DO UPDATE SET name=excluded.name,description=excluded.description,definition_path=excluded.definition_path,
          definition_hash=excluded.definition_hash,updated_at=excluded.updated_at,
          status=CASE WHEN features.definition_hash<>excluded.definition_hash THEN 'valid' ELSE features.status END,
          needs_review=CASE WHEN features.definition_hash<>excluded.definition_hash THEN 0 ELSE features.needs_review END,
          stale_reason=CASE WHEN features.definition_hash<>excluded.definition_hash THEN NULL ELSE features.stale_reason END`,
      ).run(def.id, def.name, def.description, item.definition_path, item.definition_hash, now);

      if (changed) {
        db.prepare("DELETE FROM feature_steps WHERE feature_id=?").run(def.id);
        db.prepare("DELETE FROM feature_invariants WHERE feature_id=?").run(def.id);
        const stepStmt = db.prepare(`INSERT INTO feature_steps(feature_id,step_order,action,symbol_id,file_path,observed_symbol_hash) VALUES(?,?,?,?,?,NULL)`);
        def.steps.forEach((step, index) => stepStmt.run(def.id, Number(step.order ?? index + 1), String(step.action ?? ""), step.symbol_id ?? null, step.file_path ?? null));
        const invStmt = db.prepare("INSERT INTO feature_invariants(feature_id,invariant_order,text) VALUES(?,?,?)");
        def.invariants.forEach((text, index) => invStmt.run(def.id, index + 1, String(text)));
      }
    }
    const current = db.prepare("SELECT feature_id FROM features").all().map((r) => r.feature_id);
    for (const id of current) if (!seen.has(id)) db.prepare("DELETE FROM features WHERE feature_id=?").run(id);
  });
}

export function refreshFeatureStatus(db, now) {
  const features = db.prepare("SELECT feature_id FROM features ORDER BY feature_id").all();
  const getSteps = db.prepare(`SELECT fs.*, s.implementation_hash, s.semantic_hash, s.file_path AS current_file, s.line_start, s.line_end, s.signature, s.params_json, s.returns_json, s.description AS symbol_description
    FROM feature_steps fs LEFT JOIN symbols s ON s.symbol_id=fs.symbol_id WHERE fs.feature_id=? ORDER BY fs.step_order`);
  for (const feature of features) {
    const steps = getSteps.all(feature.feature_id);
    let unresolved = false;
    let changed = false;
    const fingerprintSteps = [];
    for (const step of steps) {
      if (step.symbol_id && !step.implementation_hash) unresolved = true;
      if (step.symbol_id && step.implementation_hash) {
        if (step.observed_symbol_hash && step.observed_symbol_hash !== step.implementation_hash) changed = true;
        db.prepare("UPDATE feature_steps SET file_path=?, observed_symbol_hash=? WHERE feature_id=? AND step_order=?")
          .run(step.current_file, step.implementation_hash, feature.feature_id, step.step_order);
      }
      fingerprintSteps.push({ order: step.step_order, symbol_id: step.symbol_id, file_path: step.current_file ?? step.file_path, implementation_hash: step.implementation_hash ?? null, semantic_hash: step.semantic_hash ?? null });
    }
    const inv = db.prepare("SELECT text FROM feature_invariants WHERE feature_id=? ORDER BY invariant_order").all(feature.feature_id).map((r)=>r.text);
    const base = db.prepare("SELECT name,description,definition_hash,needs_review,stale_reason FROM features WHERE feature_id=?").get(feature.feature_id);
    const generatedHash = hashObject({ definition_hash: base.definition_hash, steps: fingerprintSteps, invariants: inv });
    let status = "valid";
    let reason = base.stale_reason;
    let needsReview = Number(base.needs_review);
    if (unresolved) { status = "stale"; reason = "unresolved_feature_symbol"; needsReview = 1; }
    else if (changed) { status = "needs_review"; reason = "referenced_symbol_changed"; needsReview = 1; }
    else if (needsReview) status = "needs_review";
    db.prepare("UPDATE features SET status=?,needs_review=?,stale_reason=?,generated_hash=?,updated_at=? WHERE feature_id=?")
      .run(status, needsReview, reason, generatedHash, now, feature.feature_id);
  }
}

export function markFeaturesForSymbolChange(db, symbolIds, reason = "referenced_symbol_changed") {
  if (!symbolIds.length) return;
  const stmt = db.prepare(`UPDATE features SET needs_review=1,status='needs_review',stale_reason=? WHERE feature_id IN (SELECT DISTINCT feature_id FROM feature_steps WHERE symbol_id=?)`);
  for (const id of symbolIds) stmt.run(reason, id);
}

export function markFeaturesForFileChange(db, filePath, reason = "referenced_file_changed") {
  db.prepare(`UPDATE features SET needs_review=1,status='needs_review',stale_reason=? WHERE feature_id IN (SELECT DISTINCT feature_id FROM feature_steps WHERE file_path=? AND symbol_id IS NULL)`).run(reason, filePath);
}

export function reviewFeature(db, featureId, note = null) {
  const feature = db.prepare("SELECT generated_hash,status FROM features WHERE feature_id=?").get(featureId);
  if (!feature) throw new Error(`Unknown feature: ${featureId}`);
  if (feature.status === "stale") throw new Error(`Feature ${featureId} is stale because references are unresolved; repair the definition before review.`);
  const now = new Date().toISOString();
  db.prepare("UPDATE features SET needs_review=0,status='valid',stale_reason=NULL,reviewed_at=?,updated_at=? WHERE feature_id=?").run(now, now, featureId);
  db.prepare("INSERT INTO feature_reviews(feature_id,reviewed_at,generated_hash,note) VALUES(?,?,?,?)").run(featureId, now, feature.generated_hash ?? "", note);
  return { feature_id: featureId, reviewed_at: now, generated_hash: feature.generated_hash, status: "valid" };
}
