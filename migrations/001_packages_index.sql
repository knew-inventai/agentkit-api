-- migrations/001_packages_index.sql

CREATE TABLE IF NOT EXISTS packages (
  id            TEXT PRIMARY KEY,   -- "{type}/{name}", e.g. "skill/code-reviewer"
  type          TEXT NOT NULL,      -- "skill" | "prompt" | "mcp" | "plugin"
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  description   TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',   -- JSON array string
  compatible    TEXT NOT NULL DEFAULT '[]',   -- JSON array string
  author_name   TEXT NOT NULL,
  author_github TEXT,
  license       TEXT,
  repo_path     TEXT NOT NULL,
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS packages_fts USING fts5(
  id UNINDEXED,
  name,
  description,
  tags,
  content=packages,
  content_rowid=rowid
);

-- Keep FTS in sync automatically via triggers
CREATE TRIGGER IF NOT EXISTS packages_ai AFTER INSERT ON packages BEGIN
  INSERT INTO packages_fts(rowid, id, name, description, tags)
  VALUES (new.rowid, new.id, new.name, new.description, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS packages_ad AFTER DELETE ON packages BEGIN
  INSERT INTO packages_fts(packages_fts, rowid, id, name, description, tags)
  VALUES ('delete', old.rowid, old.id, old.name, old.description, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS packages_au AFTER UPDATE ON packages BEGIN
  INSERT INTO packages_fts(packages_fts, rowid, id, name, description, tags)
  VALUES ('delete', old.rowid, old.id, old.name, old.description, old.tags);
  INSERT INTO packages_fts(rowid, id, name, description, tags)
  VALUES (new.rowid, new.id, new.name, new.description, new.tags);
END;
