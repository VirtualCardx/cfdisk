import { success, errors } from '../utils/response';
import { authenticate, isAuthContext } from '../middleware/auth';
import { isValidUUID } from '../utils/validate';
import { restoreEntry, permanentlyDeleteEntry, emptyTrash } from '../utils/trash';

interface TrashItem {
  id: string;
  name: string;
  type: 'file' | 'folder';
  mime_type: string | null;
  size: number;
  deleted_at: number;
  original_parent_id: string | null;
  deletion_batch_id: string | null;
}

export async function handleListTrash(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    /**
     * 只返回回收站的「根」：原父目录不在回收站，或与父节点不属于同一删除批次。
     * 用批次比较而不是 deleted_at 相等，子项先于父目录删除时也能正确归位。
     */
    const { results } = await env.DB.prepare(
      `SELECT f.id, f.name, f.type, f.mime_type, f.size, f.deleted_at,
              f.original_parent_id, f.deletion_batch_id
       FROM files f
       LEFT JOIN files p
         ON p.id = f.original_parent_id AND p.user_id = f.user_id AND p.deleted_at IS NOT NULL
       WHERE f.user_id = ? AND f.deleted_at IS NOT NULL
         AND (p.id IS NULL OR p.deletion_batch_id IS NOT f.deletion_batch_id)
       ORDER BY f.deleted_at DESC, f.name ASC`
    )
      .bind(auth.user.id)
      .all<TrashItem>();

    return success({ files: results || [] });
  } catch (e) {
    console.error('List trash error:', e);
    return errors.serverError('Failed to list trash');
  }
}

export async function handleRestoreFile(request: Request, env: Env, fileId?: string): Promise<Response> {
  if (!fileId) return errors.badRequest('Missing file ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!isValidUUID(fileId)) {
    return errors.badRequest('Invalid file ID');
  }

  try {
    const file = await env.DB.prepare(
      `SELECT id, type, deleted_at, original_parent_id, deletion_batch_id
       FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`
    )
      .bind(fileId, auth.user.id)
      .first<{
        id: string;
        type: string;
        deleted_at: number;
        original_parent_id: string | null;
        deletion_batch_id: string | null;
      }>();

    if (!file) {
      return errors.notFound('File not found in trash');
    }

    // 原父目录可能已被删除或永久删除，此时回退到根目录
    let targetParentId = file.original_parent_id;
    if (targetParentId) {
      const parentExists = await env.DB.prepare(
        'SELECT id FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
      )
        .bind(targetParentId, auth.user.id, 'folder')
        .first();

      if (!parentExists) {
        targetParentId = null;
      }
    }

    const now = Date.now();
    await restoreEntry(env, auth.user.id, fileId, targetParentId, now, file.deletion_batch_id);

    return success({ message: 'File restored successfully', parent_id: targetParentId });
  } catch (e) {
    console.error('Restore error:', e);
    return errors.serverError('Failed to restore file');
  }
}

export async function handlePermanentDelete(request: Request, env: Env, fileId?: string): Promise<Response> {
  if (!fileId) return errors.badRequest('Missing file ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!isValidUUID(fileId)) {
    return errors.badRequest('Invalid file ID');
  }

  try {
    const file = await env.DB.prepare(
      'SELECT id, deletion_batch_id FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    )
      .bind(fileId, auth.user.id)
      .first<{ id: string; deletion_batch_id: string | null }>();

    if (!file) {
      return errors.notFound('File not found in trash');
    }

    const releasedBytes = await permanentlyDeleteEntry(
      env,
      auth.user.id,
      fileId,
      file.deletion_batch_id,
      Date.now()
    );

    return success({ message: 'File permanently deleted', released_bytes: releasedBytes });
  } catch (e) {
    console.error('Permanent delete error:', e);
    return errors.serverError('Failed to delete file');
  }
}

export async function handleEmptyTrash(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    const releasedBytes = await emptyTrash(env, auth.user.id, Date.now());
    return success({ message: 'Trash emptied successfully', released_bytes: releasedBytes });
  } catch (e) {
    console.error('Empty trash error:', e);
    return errors.serverError('Failed to empty trash');
  }
}
