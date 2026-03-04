import { success, errors } from '../utils/response';
import { authenticate, isAuthContext } from '../middleware/auth';
import { isValidUUID } from '../utils/validate';

interface TrashItem {
  id: string;
  name: string;
  type: 'file' | 'folder';
  mime_type: string | null;
  size: number;
  deleted_at: number;
  original_parent_id: string | null;
}

export async function handleListTrash(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name, type, mime_type, size, deleted_at, original_parent_id
       FROM files WHERE user_id = ? AND deleted_at IS NOT NULL
       ORDER BY deleted_at DESC`
    )
      .bind(auth.user.id)
      .all<TrashItem>();

    const rootItems = (results || []).filter((item) => {
      if (!item.original_parent_id) return true;
      const parent = results?.find((p) => p.id === item.original_parent_id);
      return !parent || parent.deleted_at !== item.deleted_at;
    });

    return success({ files: rootItems });
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
      'SELECT id, type, deleted_at, original_parent_id FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    )
      .bind(fileId, auth.user.id)
      .first<{ id: string; type: string; deleted_at: number; original_parent_id: string | null }>();

    if (!file) {
      return errors.notFound('File not found in trash');
    }

    let targetParentId = file.original_parent_id;

    if (targetParentId) {
      const parentExists = await env.DB.prepare(
        'SELECT id FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
      )
        .bind(targetParentId, auth.user.id)
        .first();

      if (!parentExists) {
        targetParentId = null;
      }
    }

    const now = Date.now();

    if (file.type === 'folder') {
      await restoreFolderRecursive(env, auth.user.id, fileId, file.deleted_at, now, targetParentId);
    } else {
      await env.DB.prepare(
        'UPDATE files SET deleted_at = NULL, parent_id = ?, original_parent_id = NULL, updated_at = ? WHERE id = ?'
      )
        .bind(targetParentId, now, fileId)
        .run();
    }

    return success({ message: 'File restored successfully' });
  } catch (e) {
    console.error('Restore error:', e);
    return errors.serverError('Failed to restore file');
  }
}

async function restoreFolderRecursive(
  env: Env,
  userId: string,
  folderId: string,
  originalDeletedAt: number,
  now: number,
  newParentId: string | null
): Promise<void> {
  await env.DB.prepare(
    'UPDATE files SET deleted_at = NULL, parent_id = ?, original_parent_id = NULL, updated_at = ? WHERE id = ? AND user_id = ?'
  )
    .bind(newParentId, now, folderId, userId)
    .run();

  const { results: children } = await env.DB.prepare(
    'SELECT id, type FROM files WHERE original_parent_id = ? AND user_id = ? AND deleted_at = ?'
  )
    .bind(folderId, userId, originalDeletedAt)
    .all<{ id: string; type: string }>();

  if (children) {
    for (const child of children) {
      if (child.type === 'folder') {
        await restoreFolderRecursive(env, userId, child.id, originalDeletedAt, now, folderId);
      } else {
        await env.DB.prepare(
          'UPDATE files SET deleted_at = NULL, parent_id = ?, original_parent_id = NULL, updated_at = ? WHERE id = ?'
        )
          .bind(folderId, now, child.id)
          .run();
      }
    }
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
      'SELECT id, type, size, r2_key, deleted_at FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    )
      .bind(fileId, auth.user.id)
      .first<{ id: string; type: string; size: number; r2_key: string | null; deleted_at: number }>();

    if (!file) {
      return errors.notFound('File not found in trash');
    }

    let totalSize = 0;
    const r2KeysToDelete: string[] = [];

    if (file.type === 'folder') {
      const result = await collectFilesForDeletion(env, auth.user.id, fileId, file.deleted_at);
      totalSize = result.totalSize;
      r2KeysToDelete.push(...result.r2Keys);
    } else {
      totalSize = file.size;
      if (file.r2_key) {
        r2KeysToDelete.push(file.r2_key);
      }
    }

    for (const key of r2KeysToDelete) {
      await env.R2.delete(key);
    }

    if (file.type === 'folder') {
      await deleteFolderPermanently(env, auth.user.id, fileId, file.deleted_at);
    }

    await env.DB.prepare('DELETE FROM files WHERE id = ? AND user_id = ?')
      .bind(fileId, auth.user.id)
      .run();

    await env.DB.prepare(
      'UPDATE users SET storage_used = storage_used - ?, updated_at = ? WHERE id = ?'
    )
      .bind(totalSize, Date.now(), auth.user.id)
      .run();

    return success({ message: 'File permanently deleted' });
  } catch (e) {
    console.error('Permanent delete error:', e);
    return errors.serverError('Failed to delete file');
  }
}

async function collectFilesForDeletion(
  env: Env,
  userId: string,
  folderId: string,
  deletedAt: number
): Promise<{ totalSize: number; r2Keys: string[] }> {
  let totalSize = 0;
  const r2Keys: string[] = [];

  const { results: children } = await env.DB.prepare(
    'SELECT id, type, size, r2_key FROM files WHERE original_parent_id = ? AND user_id = ? AND deleted_at = ?'
  )
    .bind(folderId, userId, deletedAt)
    .all<{ id: string; type: string; size: number; r2_key: string | null }>();

  if (children) {
    for (const child of children) {
      if (child.type === 'folder') {
        const result = await collectFilesForDeletion(env, userId, child.id, deletedAt);
        totalSize += result.totalSize;
        r2Keys.push(...result.r2Keys);
      } else {
        totalSize += child.size;
        if (child.r2_key) {
          r2Keys.push(child.r2_key);
        }
      }
    }
  }

  return { totalSize, r2Keys };
}

async function deleteFolderPermanently(
  env: Env,
  userId: string,
  folderId: string,
  deletedAt: number
): Promise<void> {
  const { results: children } = await env.DB.prepare(
    'SELECT id, type FROM files WHERE original_parent_id = ? AND user_id = ? AND deleted_at = ?'
  )
    .bind(folderId, userId, deletedAt)
    .all<{ id: string; type: string }>();

  if (children) {
    for (const child of children) {
      if (child.type === 'folder') {
        await deleteFolderPermanently(env, userId, child.id, deletedAt);
      }
      await env.DB.prepare('DELETE FROM files WHERE id = ? AND user_id = ?')
        .bind(child.id, userId)
        .run();
    }
  }
}

export async function handleEmptyTrash(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    const { results: trashedFiles } = await env.DB.prepare(
      'SELECT id, size, r2_key FROM files WHERE user_id = ? AND deleted_at IS NOT NULL AND type = ?'
    )
      .bind(auth.user.id, 'file')
      .all<{ id: string; size: number; r2_key: string | null }>();

    let totalSize = 0;
    if (trashedFiles) {
      for (const file of trashedFiles) {
        totalSize += file.size;
        if (file.r2_key) {
          await env.R2.delete(file.r2_key);
        }
      }
    }

    await env.DB.prepare('DELETE FROM files WHERE user_id = ? AND deleted_at IS NOT NULL')
      .bind(auth.user.id)
      .run();

    await env.DB.prepare(
      'UPDATE users SET storage_used = storage_used - ?, updated_at = ? WHERE id = ?'
    )
      .bind(totalSize, Date.now(), auth.user.id)
      .run();

    return success({ message: 'Trash emptied successfully' });
  } catch (e) {
    console.error('Empty trash error:', e);
    return errors.serverError('Failed to empty trash');
  }
}
