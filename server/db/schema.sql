-- CFDisk 最新数据库结构快照（仅供参考）
-- 实际建库/升级请使用 migrations/ 目录：wrangler d1 migrations apply cfdisk-db

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  storage_quota INTEGER NOT NULL DEFAULT 10737418240,
  storage_used INTEGER NOT NULL DEFAULT 0,
  invited_by TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Files table (includes folders)
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  deleted_at INTEGER,
  original_parent_id TEXT,
  deletion_batch_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_files_user_parent ON files(user_id, parent_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_files_user_deleted ON files(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_files_r2_key ON files(r2_key);
CREATE INDEX IF NOT EXISTS idx_files_trash_batch ON files(user_id, deleted_at, deletion_batch_id);

-- Shares table
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_token TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  expires_at INTEGER,
  allowed_referers TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  max_downloads INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(access_token);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);

-- Invite codes table
CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  created_by TEXT NOT NULL,
  used_by TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
CREATE INDEX IF NOT EXISTS idx_invite_codes_creator ON invite_codes(created_by);

-- Rate limits table (fixed-window counters for login / register / share password)
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- Revoked tokens (single-device logout, keyed by jti)
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_user ON revoked_tokens(user_id);
