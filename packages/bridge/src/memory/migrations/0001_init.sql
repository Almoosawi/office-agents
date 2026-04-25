-- Office AI Assistant — initial memory schema (v1).
-- Design: ARCHITECTURE.md §8.
-- Storage: %LocalAppData%\OfficeAIAssistant\data\memory.db (Windows).
-- Connection pragmas applied programmatically: journal_mode=WAL, synchronous=NORMAL,
-- foreign_keys=ON, busy_timeout=5000.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL CHECK (host IN ('word','excel','powerpoint','outlook')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary_id INTEGER,
  persona_version INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS host_contexts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  blob TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_results TEXT,
  host_context_id INTEGER REFERENCES host_contexts(id),
  is_private INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source_host TEXT NOT NULL,
  payload TEXT NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0,
  redacted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_observations_session_ts ON observations(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_observations_kind_ts ON observations(kind, ts);

CREATE TABLE IF NOT EXISTS session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  generated_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  citation_ids TEXT NOT NULL,
  redacted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_summaries_session ON session_summaries(session_id, generated_at);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (scope, key)
);

CREATE TABLE IF NOT EXISTS settings (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS secrets_meta (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  account TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS outlook_handles (
  handle TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  store_id TEXT,
  entry_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_state (
  skill_name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_loaded_at INTEGER,
  load_count INTEGER NOT NULL DEFAULT 0
);

-- FTS5 virtual table — single search surface across all narrative text.
-- Rows with is_private=1 are NEVER inserted (triggers below filter).
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  body,
  source UNINDEXED,
  source_id UNINDEXED,
  session_id UNINDEXED,
  ts UNINDEXED,
  is_private UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_ai_fts AFTER INSERT ON messages
WHEN NEW.is_private = 0 AND NEW.content IS NOT NULL
BEGIN
  INSERT INTO memory_fts(body, source, source_id, session_id, ts, is_private)
  VALUES (NEW.content, 'msg', NEW.id, NEW.session_id, NEW.ts, 0);
END;

CREATE TRIGGER IF NOT EXISTS observations_ai_fts AFTER INSERT ON observations
WHEN NEW.is_private = 0
BEGIN
  INSERT INTO memory_fts(body, source, source_id, session_id, ts, is_private)
  VALUES (NEW.payload, 'obs', NEW.id, NEW.session_id, NEW.ts, 0);
END;

CREATE TRIGGER IF NOT EXISTS summaries_ai_fts AFTER INSERT ON session_summaries
BEGIN
  INSERT INTO memory_fts(body, source, source_id, session_id, ts, is_private)
  VALUES (NEW.text, 'sum', NEW.id, NEW.session_id, NEW.generated_at, 0);
END;

CREATE TRIGGER IF NOT EXISTS facts_ai_fts AFTER INSERT ON facts
BEGIN
  INSERT INTO memory_fts(body, source, source_id, session_id, ts, is_private)
  VALUES (NEW.value, 'fact', NEW.id, NULL, NEW.created_at, 0);
END;

-- Schema version row used by the migration runner.
CREATE TABLE IF NOT EXISTS _schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);
INSERT OR IGNORE INTO _schema_versions(version, applied_at, description)
VALUES (1, strftime('%s','now') * 1000, 'initial schema');
