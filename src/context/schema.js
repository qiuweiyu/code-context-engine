export const SCHEMA_VERSION = 3;
export const PARSER_VERSION = "0.1.0";

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  parser_version TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1))
) STRICT;

CREATE TABLE IF NOT EXISTS symbols (
  symbol_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  language TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  receiver TEXT,
  signature TEXT NOT NULL,
  params_json TEXT NOT NULL,
  returns_json TEXT NOT NULL,
  description TEXT NOT NULL,
  description_source TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  implementation_hash TEXT NOT NULL,
  semantic_hash TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified_name);

CREATE TABLE IF NOT EXISTS dependencies (
  id INTEGER PRIMARY KEY,
  from_file TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  from_symbol_id TEXT,
  relation TEXT NOT NULL,
  to_ref TEXT NOT NULL,
  to_file TEXT,
  resolved_symbol_id TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_dep_from_symbol ON dependencies(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_dep_resolved_symbol ON dependencies(resolved_symbol_id);
CREATE INDEX IF NOT EXISTS idx_dep_from_file ON dependencies(from_file);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  symbol_id TEXT,
  method TEXT NOT NULL,
  route_path TEXT NOT NULL,
  direction TEXT NOT NULL,
  line INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_routes_path ON routes(route_path);

CREATE TABLE IF NOT EXISTS db_objects (
  id INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  symbol_id TEXT,
  object_type TEXT NOT NULL,
  object_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  line INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_db_object_name ON db_objects(object_name);

CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY,
  test_file TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  test_symbol_id TEXT,
  target_file TEXT,
  target_symbol_id TEXT,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_tests_target_file ON tests(target_file);
CREATE INDEX IF NOT EXISTS idx_tests_target_symbol ON tests(target_symbol_id);

CREATE TABLE IF NOT EXISTS features (
  feature_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  definition_path TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),
  stale_reason TEXT,
  generated_hash TEXT,
  reviewed_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS feature_steps (
  feature_id TEXT NOT NULL REFERENCES features(feature_id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  action TEXT NOT NULL,
  symbol_id TEXT,
  file_path TEXT,
  observed_symbol_hash TEXT,
  PRIMARY KEY(feature_id, step_order)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_feature_steps_symbol ON feature_steps(symbol_id);
CREATE INDEX IF NOT EXISTS idx_feature_steps_file ON feature_steps(file_path);

CREATE TABLE IF NOT EXISTS feature_invariants (
  feature_id TEXT NOT NULL REFERENCES features(feature_id) ON DELETE CASCADE,
  invariant_order INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY(feature_id, invariant_order)
) STRICT;

CREATE TABLE IF NOT EXISTS change_events (
  id INTEGER PRIMARY KEY,
  indexed_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_path TEXT,
  symbol_id TEXT,
  old_hash TEXT,
  new_hash TEXT,
  detail TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_changes_symbol ON change_events(symbol_id);

CREATE TABLE IF NOT EXISTS feature_reviews (
  id INTEGER PRIMARY KEY,
  feature_id TEXT NOT NULL REFERENCES features(feature_id) ON DELETE CASCADE,
  reviewed_at TEXT NOT NULL,
  generated_hash TEXT NOT NULL,
  note TEXT
) STRICT;
`;
