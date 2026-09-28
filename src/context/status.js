import fs from "node:fs/promises";
import path from "node:path";
import { listTrackedSourceFiles, readGitHead, resolveGitRoot } from "../git.js";
import { runtimeIdentity } from "../runtime.js";
import { sha256Text } from "./hash.js";
import { detectLanguage } from "./language.js";
import { DEFAULT_ANALYZERS, parserVersionFor } from "./analyzers.js";
import { openStore } from "./store.js";

function meta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value ?? null;
}

async function readLocalSource(repoRoot, relPath) {
  const full = path.resolve(repoRoot, relPath);
  const rel = path.relative(repoRoot, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path traversal rejected");
  }
  const stat = await fs.lstat(full);
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  if (stat.size > 4 * 1024 * 1024) return null;
  const buffer = await fs.readFile(full);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function samplePush(target, value, limit = 8) {
  if (target.length < limit) target.push(value);
}

export async function readIndexStatus({
  repoRoot,
  indexDir = ".context-index",
  analyzerRegistry = DEFAULT_ANALYZERS
}) {
  const gitRoot = await resolveGitRoot(repoRoot);
  const dir = path.isAbsolute(indexDir) ? indexDir : path.join(gitRoot, indexDir);
  const { db, dbPath } = openStore(dir);
  try {
    const count = (table) =>
      Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    const diagnostics = JSON.parse(meta(db, "analysis_diagnostics") ?? "[]");
    const indexedRows = db.prepare(
      "SELECT path,language,content_hash,parser_version FROM files ORDER BY path"
    ).all();
    const indexedMap = new Map(indexedRows.map((row) => [row.path, row]));
    const currentPaths = (await listTrackedSourceFiles(gitRoot))
      .filter((relPath) =>
        !relPath.startsWith(".context-index/")
        && !relPath.startsWith(".context-features/")
      );
    const currentSet = new Set(currentPaths);

    const added = [];
    const removed = [];
    const changed = [];
    const parserChanged = [];
    const unreadable = [];

    for (const relPath of currentPaths) {
      let text;
      try {
        text = await readLocalSource(gitRoot, relPath);
      } catch {
        samplePush(unreadable, relPath);
        continue;
      }
      if (text === null) {
        samplePush(unreadable, relPath);
        continue;
      }

      const indexed = indexedMap.get(relPath);
      if (!indexed) {
        samplePush(added, relPath);
        continue;
      }

      const contentHash = sha256Text(text);
      if (indexed.content_hash !== contentHash) {
        samplePush(changed, relPath);
      }

      const language = detectLanguage(relPath);
      const currentParser = parserVersionFor(language, analyzerRegistry);
      if (indexed.parser_version !== currentParser) {
        samplePush(parserChanged, relPath);
      }
    }

    for (const row of indexedRows) {
      if (!currentSet.has(row.path)) samplePush(removed, row.path);
    }

    const runtime = runtimeIdentity();
    const indexedRuntimeFingerprint = meta(db, "runtime_fingerprint");
    const runtimeFingerprintMatch =
      Boolean(indexedRuntimeFingerprint)
      && indexedRuntimeFingerprint === runtime.runtime_fingerprint;

    const repositoryHead = await readGitHead(gitRoot);
    const indexedRepositoryHead = meta(db, "repository_head");
    const staleReasons = {
      added_files: added.length,
      removed_files: removed.length,
      changed_files: changed.length,
      parser_changed_files: parserChanged.length,
      unreadable_files: unreadable.length,
      runtime_fingerprint_mismatch: runtimeFingerprintMatch ? 0 : 1
    };
    const stale = Object.values(staleReasons).some((value) => value > 0);

    return {
      ok: true,
      stale,
      freshness: {
        stale,
        reasons: staleReasons,
        samples: {
          added_files: added,
          removed_files: removed,
          changed_files: changed,
          parser_changed_files: parserChanged,
          unreadable_files: unreadable
        }
      },
      runtime,
      index_provenance: {
        indexed_runtime_fingerprint: indexedRuntimeFingerprint,
        indexed_runtime_package_version: meta(db, "runtime_package_version"),
        indexed_runtime_git_head: meta(db, "runtime_git_head"),
        indexed_repository_head: indexedRepositoryHead,
        current_repository_head: repositoryHead
      },
      ...(diagnostics.length ? { analysis_diagnostics: diagnostics } : {}),
      database: dbPath,
      indexed_at: meta(db, "last_indexed_at"),
      repository: meta(db, "repository_root") ?? gitRoot,
      counts: {
        files: count("files"),
        symbols: count("symbols"),
        features: count("features"),
        dependencies: count("dependencies"),
        routes: count("routes"),
        db_objects: count("db_objects"),
        tests: count("tests")
      },
      features: db.prepare(
        "SELECT feature_id,name,status,needs_review,stale_reason,generated_hash,reviewed_at FROM features ORDER BY feature_id"
      ).all()
    };
  } finally {
    db.close();
  }
}
