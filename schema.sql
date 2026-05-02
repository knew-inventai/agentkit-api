-- 下載次數統計
CREATE TABLE IF NOT EXISTS package_stats (
  package_id  TEXT PRIMARY KEY,
  downloads   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 👍 記錄（每位使用者每個 package 只能按一次）
CREATE TABLE IF NOT EXISTS package_likes (
  package_id  TEXT NOT NULL,
  github_user TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (package_id, github_user)
);

-- 查詢常用的 index
CREATE INDEX IF NOT EXISTS idx_likes_package ON package_likes(package_id);

-- Package manifest index (synced from category repos via GitHub Actions)
CREATE TABLE IF NOT EXISTS packages (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  description   TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  compatible    TEXT NOT NULL DEFAULT '[]',
  author_name   TEXT NOT NULL,
  author_github TEXT,
  license       TEXT,
  repo_path     TEXT NOT NULL,
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS packages_fts USING fts5(
  id UNINDEXED, name, description, tags,
  content=packages, content_rowid=rowid
);
