/**
 * 回收站子树操作
 *
 * 设计要点：
 * 1. 父子关系一律按 original_parent_id / parent_id 结构遍历，**不再依赖 deleted_at 相等**。
 *    旧实现用时间戳匹配子项，先删子项再删父目录时会漏删、漏算配额，留下孤儿记录。
 * 2. 每次软删除生成一个 deletion_batch_id，整棵子树共享，代表「同一次删除操作」。
 *    恢复与永久删除都只作用于同一批次构成的闭包：
 *    - 之前单独删除过的子项属于另一个批次，既不会被顺带恢复，也不会被顺带删除
 *    - 它自身的父目录若已消失，仍会在回收站里作为独立条目出现（列表按 LEFT JOIN 判定根节点）
 * 3. 所有遍历都用递归 CTE 一次查询完成，并带深度上限，防御脏数据造成的环。
 */

import { releaseQuota } from './quota';

const MAX_TREE_DEPTH = 64;
const R2_DELETE_BATCH = 100;

export interface TrashNode {
  id: string;
  type: 'file' | 'folder';
  size: number;
  r2_key: string | null;
  thumb_r2_key: string | null;
  deletion_batch_id: string | null;
}

/**
 * 软删除整棵子树（仅包含当前未删除的节点）。
 * 已处于回收站的子项保持原批次不变，不会被卷入本次删除。
 */
export async function softDeleteTree(
  env: Env,
  userId: string,
  rootId: string,
  now: number,
  batchId: string = crypto.randomUUID()
): Promise<number> {
  const result = await env.DB.prepare(
    `WITH RECURSIVE tree(id, depth) AS (
       SELECT id, 0 FROM files
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL
       UNION ALL
       SELECT f.id, t.depth + 1 FROM files f
       JOIN tree t ON f.parent_id = t.id
       WHERE f.user_id = ? AND f.deleted_at IS NULL AND t.depth < ${MAX_TREE_DEPTH}
     )
     UPDATE files
     SET deleted_at = ?, original_parent_id = parent_id, deletion_batch_id = ?, updated_at = ?
     WHERE id IN (SELECT id FROM tree)`
  )
    .bind(rootId, userId, userId, now, batchId, now)
    .run();

  return result.meta.changes ?? 0;
}

/**
 * 收集一个回收站条目对应的批次闭包（根节点 + 同批次的连续后代）。
 * batchId 传空串时退化为按结构收集全部已删除后代。
 */
export async function collectTrashClosure(
  env: Env,
  userId: string,
  rootId: string,
  batchId: string | null
): Promise<TrashNode[]> {
  const batch = batchId || '';

  const { results } = await env.DB.prepare(
    `WITH RECURSIVE tree(id, type, size, r2_key, thumb_r2_key, deletion_batch_id, depth) AS (
       SELECT id, type, size, r2_key, thumb_r2_key, deletion_batch_id, 0
       FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL
       UNION ALL
       SELECT f.id, f.type, f.size, f.r2_key, f.thumb_r2_key, f.deletion_batch_id, t.depth + 1
       FROM files f
       JOIN tree t ON f.original_parent_id = t.id
       WHERE f.user_id = ? AND f.deleted_at IS NOT NULL
         AND (? = '' OR f.deletion_batch_id = ?)
         AND t.depth < ${MAX_TREE_DEPTH}
     )
     SELECT id, type, size, r2_key, thumb_r2_key, deletion_batch_id FROM tree`
  )
    .bind(rootId, userId, userId, batch, batch)
    .all<TrashNode>();

  return results || [];
}

/**
 * 恢复一个回收站条目：根节点挂到 newParentId，同批次后代保持内部父子关系。
 */
export async function restoreEntry(
  env: Env,
  userId: string,
  rootId: string,
  newParentId: string | null,
  now: number,
  batchId: string | null
): Promise<void> {
  const batch = batchId || '';

  await env.DB.prepare(
    `UPDATE files
     SET deleted_at = NULL, parent_id = ?, original_parent_id = NULL,
         deletion_batch_id = NULL, updated_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`
  )
    .bind(newParentId, now, rootId, userId)
    .run();

  await env.DB.prepare(
    `WITH RECURSIVE tree(id, depth) AS (
       SELECT id, 0 FROM files
       WHERE original_parent_id = ? AND user_id = ? AND deleted_at IS NOT NULL
         AND (? = '' OR deletion_batch_id = ?)
       UNION ALL
       SELECT f.id, t.depth + 1 FROM files f
       JOIN tree t ON f.original_parent_id = t.id
       WHERE f.user_id = ? AND f.deleted_at IS NOT NULL
         AND (? = '' OR f.deletion_batch_id = ?)
         AND t.depth < ${MAX_TREE_DEPTH}
     )
     UPDATE files
     SET deleted_at = NULL, original_parent_id = NULL, deletion_batch_id = NULL, updated_at = ?
     WHERE id IN (SELECT id FROM tree)`
  )
    .bind(rootId, userId, batch, batch, userId, batch, batch, now)
    .run();
}

/**
 * 永久删除一个回收站条目（批次闭包）：返回释放的字节数。
 *
 * 先删 R2 对象再删记录。若中途失败，记录仍在回收站，重试即可自愈；
 * 反过来先删记录可能留下无人引用的对象。
 */
export async function permanentlyDeleteEntry(
  env: Env,
  userId: string,
  rootId: string,
  batchId: string | null,
  now: number
): Promise<number> {
  const batch = batchId || '';
  const nodes = await collectTrashClosure(env, userId, rootId, batch);

  let releasedBytes = 0;
  const r2Keys: string[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      releasedBytes += node.size || 0;
      if (node.r2_key) r2Keys.push(node.r2_key);
      // 缩略图是独立对象，不跟着主对象回收，必须一起删掉
      if (node.thumb_r2_key) r2Keys.push(node.thumb_r2_key);
    }
  }

  for (let i = 0; i < r2Keys.length; i += R2_DELETE_BATCH) {
    await env.R2.delete(r2Keys.slice(i, i + R2_DELETE_BATCH));
  }

  await env.DB.prepare(
    `WITH RECURSIVE tree(id, depth) AS (
       SELECT id, 0 FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL
       UNION ALL
       SELECT f.id, t.depth + 1 FROM files f
       JOIN tree t ON f.original_parent_id = t.id
       WHERE f.user_id = ? AND f.deleted_at IS NOT NULL
         AND (? = '' OR f.deletion_batch_id = ?)
         AND t.depth < ${MAX_TREE_DEPTH}
     )
     DELETE FROM files WHERE id IN (SELECT id FROM tree)`
  )
    .bind(rootId, userId, userId, batch, batch)
    .run();

  if (releasedBytes > 0) {
    await releaseQuota(env, userId, releasedBytes, now);
  }

  return releasedBytes;
}

/** 清空回收站：物理删除全部已删除记录，返回释放的字节数 */
export async function emptyTrash(env: Env, userId: string, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT size, r2_key, thumb_r2_key FROM files
     WHERE user_id = ? AND deleted_at IS NOT NULL AND type = 'file'`
  )
    .bind(userId)
    .all<{ size: number; r2_key: string | null; thumb_r2_key: string | null }>();

  const rows = results || [];
  let releasedBytes = 0;
  const r2Keys: string[] = [];
  for (const row of rows) {
    releasedBytes += row.size || 0;
    if (row.r2_key) r2Keys.push(row.r2_key);
    if (row.thumb_r2_key) r2Keys.push(row.thumb_r2_key);
  }

  for (let i = 0; i < r2Keys.length; i += R2_DELETE_BATCH) {
    await env.R2.delete(r2Keys.slice(i, i + R2_DELETE_BATCH));
  }

  await env.DB.prepare('DELETE FROM files WHERE user_id = ? AND deleted_at IS NOT NULL')
    .bind(userId)
    .run();

  if (releasedBytes > 0) {
    await releaseQuota(env, userId, releasedBytes, now);
  }

  return releasedBytes;
}
