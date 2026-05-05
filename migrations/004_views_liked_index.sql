ALTER TABLE package_stats RENAME COLUMN downloads TO views;

-- 為 GET /users/me/likes 查詢加速
CREATE INDEX IF NOT EXISTS idx_likes_user ON package_likes(github_user);
