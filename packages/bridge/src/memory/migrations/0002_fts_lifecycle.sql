-- 0002 — close the FTS5 lifecycle holes flagged in the GPT review.
--
-- 0001 only had AFTER INSERT triggers. Deleted facts and cascade-deleted
-- messages/observations/summaries (via session DELETE) left stale rows in
-- memory_fts that kept matching searches. Privacy flips (is_private 0->1)
-- also weren't reflected.
--
-- This migration adds AFTER DELETE and AFTER UPDATE OF is_private triggers
-- so the FTS index always tracks the source-of-truth tables. SQLite *does*
-- fire triggers on rows deleted via ON DELETE CASCADE, so cascading session
-- deletes correctly purge child rows from FTS via these triggers.

-- ---------------- DELETE triggers ----------------

CREATE TRIGGER IF NOT EXISTS messages_ad_fts AFTER DELETE ON messages BEGIN
  DELETE FROM memory_fts WHERE source = 'msg' AND source_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS observations_ad_fts AFTER DELETE ON observations BEGIN
  DELETE FROM memory_fts WHERE source = 'obs' AND source_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS summaries_ad_fts AFTER DELETE ON session_summaries BEGIN
  DELETE FROM memory_fts WHERE source = 'sum' AND source_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS facts_ad_fts AFTER DELETE ON facts BEGIN
  DELETE FROM memory_fts WHERE source = 'fact' AND source_id = OLD.id;
END;

-- ---------------- UPDATE triggers (privacy flip + content edit) ----------------

-- Messages: re-index when content changes or privacy toggles.
CREATE TRIGGER IF NOT EXISTS messages_au_fts AFTER UPDATE OF content, is_private ON messages BEGIN
  DELETE FROM memory_fts WHERE source = 'msg' AND source_id = OLD.id;
  INSERT INTO memory_fts(body, source, source_id, session_id, ts, is_private)
  SELECT NEW.content, 'msg', NEW.id, NEW.session_id, NEW.ts, 0
  WHERE NEW.is_private = 0 AND NEW.content IS NOT NULL;
END;

-- Observations: re-index on payload or privacy change.
CREATE TRIGGER IF NOT EXISTS observations_au_fts AFTER UPDATE OF payload, is_private ON observations BEGIN
  DELETE FROM memory_fts WHERE source = 'obs' AND source_id = OLD.id;
  INSERT INTO memory_fts(body, source, source_id, session_id, ts, is_private)
  SELECT NEW.payload, 'obs', NEW.id, NEW.session_id, NEW.ts, 0
  WHERE NEW.is_private = 0;
END;

-- Summaries: re-index on text change.
CREATE TRIGGER IF NOT EXISTS summaries_au_fts AFTER UPDATE OF text ON session_summaries BEGIN
  DELETE FROM memory_fts WHERE source = 'sum' AND source_id = OLD.id;
  INSERT INTO memory_fts(body, source, source_id, session_id, ts, is_private)
  VALUES (NEW.text, 'sum', NEW.id, NEW.session_id, NEW.generated_at, 0);
END;

-- Facts: re-index when value changes (upsert path).
CREATE TRIGGER IF NOT EXISTS facts_au_fts AFTER UPDATE OF value ON facts BEGIN
  DELETE FROM memory_fts WHERE source = 'fact' AND source_id = OLD.id;
  INSERT INTO memory_fts(body, source, source_id, session_id, ts, is_private)
  VALUES (NEW.value, 'fact', NEW.id, NULL, NEW.updated_at, 0);
END;

INSERT OR IGNORE INTO _schema_versions(version, applied_at, description)
VALUES (2, strftime('%s','now') * 1000, 'FTS lifecycle: DELETE + UPDATE triggers; privacy-flip aware');
