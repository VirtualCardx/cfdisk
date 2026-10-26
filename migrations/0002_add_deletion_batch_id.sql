-- 0002 · 回收站删除批次
--
-- 旧实现用 deleted_at 相等来认定「同一个文件夹里的子项」，
-- 先删子项、后删父目录时两者时间戳不同，子项会被漏删/漏恢复并留下孤儿记录。
-- 这里给每次删除操作打一个批次号，整棵子树共享。

ALTER TABLE files ADD COLUMN deletion_batch_id TEXT;

-- 回填历史数据：同一时间戳归为同一批次，保持迁移前的分组语义
UPDATE files
SET deletion_batch_id = 'legacy-' || deleted_at
WHERE deleted_at IS NOT NULL AND deletion_batch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_files_trash_batch
  ON files(user_id, deleted_at, deletion_batch_id);
