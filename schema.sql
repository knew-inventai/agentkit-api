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
