import { success, errors } from '../utils/response';
import { authenticate, isAuthContext } from '../middleware/auth';
import { isValidFileName, isValidUUID, sanitizeFileName } from '../utils/validate';

export async function handleCreateFolder(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    const body = await request.json<{ name: string; parent_id?: string }>();
    const { name, parent_id } = body;

    if (!name || !isValidFileName(name)) {
      return errors.badRequest('Invalid folder name');
    }

    if (parent_id) {
      if (!isValidUUID(parent_id)) {
        return errors.badRequest('Invalid parent folder ID');
      }

      const parentFolder = await env.DB.prepare(
        'SELECT id FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
      )
        .bind(parent_id, auth.user.id, 'folder')
        .first();

      if (!parentFolder) {
        return errors.notFound('Parent folder not found');
      }
    }

    const existingFolder = await env.DB.prepare(
      parent_id
        ? 'SELECT id FROM files WHERE name = ? AND parent_id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
        : 'SELECT id FROM files WHERE name = ? AND parent_id IS NULL AND user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(...(parent_id ? [name, parent_id, auth.user.id, 'folder'] : [name, auth.user.id, 'folder']))
      .first();

    if (existingFolder) {
      return errors.conflict('A folder with this name already exists');
    }

    const folderId = crypto.randomUUID();
    const now = Date.now();
    const safeName = sanitizeFileName(name);

    await env.DB.prepare(
      `INSERT INTO files (id, user_id, parent_id, name, type, size, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'folder', 0, ?, ?)`
    )
      .bind(folderId, auth.user.id, parent_id || null, safeName, now, now)
      .run();

    return success({
      folder: {
        id: folderId,
        name: safeName,
        type: 'folder',
        parent_id: parent_id || null,
        created_at: now,
        updated_at: now,
      },
    }, 201);
  } catch (e) {
    console.error('Create folder error:', e);
    return errors.serverError('Failed to create folder');
  }
}

export async function handleRenameFolder(request: Request, env: Env, folderId?: string): Promise<Response> {
  if (!folderId) return errors.badRequest('Missing folder ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!isValidUUID(folderId)) {
    return errors.badRequest('Invalid folder ID');
  }

  try {
    const body = await request.json<{ name: string }>();
    const { name } = body;

    if (!name || !isValidFileName(name)) {
      return errors.badRequest('Invalid folder name');
    }

    const folder = await env.DB.prepare(
      'SELECT id, parent_id FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(folderId, auth.user.id, 'folder')
      .first<{ id: string; parent_id: string | null }>();

    if (!folder) {
      return errors.notFound('Folder not found');
    }

    const existingFolder = await env.DB.prepare(
      folder.parent_id
        ? 'SELECT id FROM files WHERE name = ? AND parent_id = ? AND user_id = ? AND type = ? AND id != ? AND deleted_at IS NULL'
        : 'SELECT id FROM files WHERE name = ? AND parent_id IS NULL AND user_id = ? AND type = ? AND id != ? AND deleted_at IS NULL'
    )
      .bind(...(folder.parent_id
        ? [name, folder.parent_id, auth.user.id, 'folder', folderId]
        : [name, auth.user.id, 'folder', folderId]))
      .first();

    if (existingFolder) {
      return errors.conflict('A folder with this name already exists');
    }

    const safeName = sanitizeFileName(name);
    await env.DB.prepare(
      'UPDATE files SET name = ?, updated_at = ? WHERE id = ?'
    )
      .bind(safeName, Date.now(), folderId)
      .run();

    return success({ message: 'Folder renamed successfully' });
  } catch (e) {
    console.error('Rename folder error:', e);
    return errors.serverError('Failed to rename folder');
  }
}

export async function handleDeleteFolder(request: Request, env: Env, folderId?: string): Promise<Response> {
  if (!folderId) return errors.badRequest('Missing folder ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!isValidUUID(folderId)) {
    return errors.badRequest('Invalid folder ID');
  }

  try {
    const folder = await env.DB.prepare(
      'SELECT id, parent_id FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(folderId, auth.user.id, 'folder')
      .first<{ id: string; parent_id: string | null }>();

    if (!folder) {
      return errors.notFound('Folder not found');
    }

    const now = Date.now();
    await deleteFolderRecursive(env, auth.user.id, folderId, now, folder.parent_id);

    return success({ message: 'Folder moved to trash' });
  } catch (e) {
    console.error('Delete folder error:', e);
    return errors.serverError('Failed to delete folder');
  }
}

async function deleteFolderRecursive(
  env: Env,
  userId: string,
  folderId: string,
  deletedAt: number,
  originalParentId: string | null
): Promise<void> {
  await env.DB.prepare(
    'UPDATE files SET deleted_at = ?, original_parent_id = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  )
    .bind(deletedAt, originalParentId, deletedAt, folderId, userId)
    .run();

  const { results: children } = await env.DB.prepare(
    'SELECT id, type, parent_id FROM files WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL'
  )
    .bind(folderId, userId)
    .all<{ id: string; type: string; parent_id: string }>();

  if (children) {
    for (const child of children) {
      if (child.type === 'folder') {
        await deleteFolderRecursive(env, userId, child.id, deletedAt, child.parent_id);
      } else {
        await env.DB.prepare(
          'UPDATE files SET deleted_at = ?, original_parent_id = parent_id, updated_at = ? WHERE id = ?'
        )
          .bind(deletedAt, deletedAt, child.id)
          .run();
      }
    }
  }
}

export async function handleGetFolder(request: Request, env: Env, folderId?: string): Promise<Response> {
  if (!folderId) return errors.badRequest('Missing folder ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!isValidUUID(folderId)) {
    return errors.badRequest('Invalid folder ID');
  }

  try {
    const folder = await env.DB.prepare(
      'SELECT id, name, parent_id, created_at, updated_at FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(folderId, auth.user.id, 'folder')
      .first<{ id: string; name: string; parent_id: string | null; created_at: number; updated_at: number }>();

    if (!folder) {
      return errors.notFound('Folder not found');
    }

    return success({ folder });
  } catch (e) {
    console.error('Get folder error:', e);
    return errors.serverError('Failed to get folder');
  }
}
