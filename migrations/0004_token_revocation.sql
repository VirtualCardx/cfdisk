-- 0004 · Token 吊销
--
-- token_version：用户级版本号。签发的 JWT 带上当时的版本号，
-- 改密码 / 改角色 / 禁用时 +1，此前签发的所有 token 立即失效。
--
-- revoked_tokens：单次登出的 jti 黑名单，只影响当前设备。
-- 记录在 exp 之后无意义，由写入路径按概率清理。

ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_user ON revoked_tokens(user_id);
