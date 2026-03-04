import { success, errors } from '../utils/response';
import { authenticate, isAuthContext } from '../middleware/auth';
import { isValidFileName, isValidUUID, getMimeType, sanitizeFileName } from '../utils/validate';

interface FileRecord {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  type: 'file' | 'folder';
  mime_type: string | null;
  size: number;
  r2_key: string | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export async function handleListFiles(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  const url = new URL(request.url);
  const parentId = url.searchParams.get('parent_id') || null;
  const sort = url.searchParams.get('sort') || 'name';
  const order = url.searchParams.get('order') || 'asc';

  const validSorts = ['name', 'size', 'created_at', 'updated_at'];
  const sortColumn = validSorts.includes(sort) ? sort : 'name';
  const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

  try {
    const query = parentId
      ? `SELECT id, parent_id, name, type, mime_type, size, created_at, updated_at
         FROM files WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL
         ORDER BY type DESC, ${sortColumn} ${sortOrder}`
      : `SELECT id, parent_id, name, type, mime_type, size, created_at, updated_at
         FROM files WHERE user_id = ? AND parent_id IS NULL AND deleted_at IS NULL
         ORDER BY type DESC, ${sortColumn} ${sortOrder}`;

    const stmt = parentId
      ? env.DB.prepare(query).bind(auth.user.id, parentId)
      : env.DB.prepare(query).bind(auth.user.id);

    const { results } = await stmt.all<FileRecord>();

    let path: { id: string; name: string }[] = [];
    if (parentId) {
      path = await buildPath(env, parentId);
    }

    return success({ files: results || [], path });
  } catch (e) {
    console.error('List files error:', e);
    return errors.serverError('Failed to list files');
  }
}

interface FolderPathItem {
  id: string;
  name: string;
  parent_id: string | null;
}

async function buildPath(env: Env, folderId: string): Promise<{ id: string; name: string }[]> {
  const path: { id: string; name: string }[] = [];
  let currentId: string | null = folderId;

  while (currentId) {
    const result: FolderPathItem | null = await env.DB.prepare(
      'SELECT id, name, parent_id FROM files WHERE id = ? AND type = ?'
    )
      .bind(currentId, 'folder')
      .first();

    if (!result) break;
    path.unshift({ id: result.id, name: result.name });
    currentId = result.parent_id;
  }

  return path;
}

export async function handleGetUploadUrl(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    const body = await request.json<{
      filename: string;
      size: number;
      parent_id?: string;
    }>();

    const { filename, size, parent_id } = body;

    if (!filename || typeof size !== 'number') {
      return errors.badRequest('Missing filename or size');
    }

    if (!isValidFileName(filename)) {
      return errors.badRequest('Invalid filename');
    }

    if (size <= 0) {
      return errors.badRequest('Invalid file size');
    }

    if (auth.user.storage_used + size > auth.user.storage_quota) {
      return errors.quotaExceeded();
    }

    if (parent_id) {
      const parentFolder = await env.DB.prepare(
        'SELECT id FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
      )
        .bind(parent_id, auth.user.id, 'folder')
        .first();

      if (!parentFolder) {
        return errors.notFound('Parent folder not found');
      }
    }

    const fileId = crypto.randomUUID();
    const r2Key = `${auth.user.id}/${fileId}`;
    const mimeType = getMimeType(filename);

    const uploadUrl = await env.R2.createMultipartUpload(r2Key);

    return success({
      file_id: fileId,
      r2_key: r2Key,
      upload_id: uploadUrl.uploadId,
      mime_type: mimeType,
    });
  } catch (e) {
    console.error('Get upload URL error:', e);
    return errors.serverError('Failed to get upload URL');
  }
}

export async function handleConfirmUpload(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    const body = await request.json<{
      file_id: string;
      r2_key: string;
      filename: string;
      size: number;
      parent_id?: string;
      upload_id?: string;
      parts?: { partNumber: number; etag: string }[];
    }>();

    const { file_id, r2_key, filename, size, parent_id, upload_id, parts } = body;

    if (!file_id || !r2_key || !filename || typeof size !== 'number') {
      return errors.badRequest('Missing required fields');
    }

    if (auth.user.storage_used + size > auth.user.storage_quota) {
      return errors.quotaExceeded();
    }

    if (upload_id && parts) {
      const upload = env.R2.resumeMultipartUpload(r2_key, upload_id);
      await upload.complete(parts);
    }

    const obj = await env.R2.head(r2_key);
    if (!obj) {
      return errors.notFound('File not found in storage');
    }

    const now = Date.now();
    const mimeType = getMimeType(filename);
    const safeName = sanitizeFileName(filename);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO files (id, user_id, parent_id, name, type, mime_type, size, r2_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?)`
      ).bind(file_id, auth.user.id, parent_id || null, safeName, mimeType, obj.size, r2_key, now, now),
      env.DB.prepare(
        'UPDATE users SET storage_used = storage_used + ?, updated_at = ? WHERE id = ?'
      ).bind(obj.size, now, auth.user.id),
    ]);

    return success({
      file: {
        id: file_id,
        name: safeName,
        type: 'file',
        mime_type: mimeType,
        size: obj.size,
        created_at: now,
        updated_at: now,
      },
    }, 201);
  } catch (e) {
    console.error('Confirm upload error:', e);
    return errors.serverError('Failed to confirm upload');
  }
}

export async function handleDirectUpload(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const parentId = formData.get('parent_id') as string | null;

    if (!file) {
      return errors.badRequest('No file provided');
    }

    if (!isValidFileName(file.name)) {
      return errors.badRequest('Invalid filename');
    }

    if (auth.user.storage_used + file.size > auth.user.storage_quota) {
      return errors.quotaExceeded();
    }

    if (parentId) {
      const parentFolder = await env.DB.prepare(
        'SELECT id FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
      )
        .bind(parentId, auth.user.id, 'folder')
        .first();

      if (!parentFolder) {
        return errors.notFound('Parent folder not found');
      }
    }

    const fileId = crypto.randomUUID();
    const r2Key = `${auth.user.id}/${fileId}`;
    const mimeType = getMimeType(file.name);
    const safeName = sanitizeFileName(file.name);

    await env.R2.put(r2Key, file.stream(), {
      httpMetadata: { contentType: mimeType },
    });

    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO files (id, user_id, parent_id, name, type, mime_type, size, r2_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?)`
      ).bind(fileId, auth.user.id, parentId, safeName, mimeType, file.size, r2Key, now, now),
      env.DB.prepare(
        'UPDATE users SET storage_used = storage_used + ?, updated_at = ? WHERE id = ?'
      ).bind(file.size, now, auth.user.id),
    ]);

    return success({
      file: {
        id: fileId,
        name: safeName,
        type: 'file',
        mime_type: mimeType,
        size: file.size,
        created_at: now,
        updated_at: now,
      },
    }, 201);
  } catch (e) {
    console.error('Direct upload error:', e);
    return errors.serverError('Failed to upload file');
  }
}

export async function handleDownload(request: Request, env: Env, fileId?: string): Promise<Response> {
  if (!fileId) return errors.badRequest('Missing file ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!isValidUUID(fileId)) {
    return errors.badRequest('Invalid file ID');
  }

  try {
    const file = await env.DB.prepare(
      'SELECT name, r2_key, mime_type FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(fileId, auth.user.id, 'file')
      .first<{ name: string; r2_key: string; mime_type: string }>();

    if (!file) {
      return errors.notFound('File not found');
    }

    const obj = await env.R2.get(file.r2_key);
    if (!obj) {
      return errors.notFound('File not found in storage');
    }

    const headers = new Headers();
    headers.set('Content-Type', file.mime_type || 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    headers.set('Content-Length', String(obj.size));

    return new Response(obj.body, { headers });
  } catch (e) {
    console.error('Download error:', e);
    return errors.serverError('Failed to download file');
  }
}

export async function handleRename(request: Request, env: Env, fileId?: string): Promise<Response> {
  if (!fileId) return errors.badRequest('Missing file ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!isValidUUID(fileId)) {
    return errors.badRequest('Invalid file ID');
  }

  try {
    const body = await request.json<{ name: string }>();
    const { name } = body;

    if (!name || !isValidFileName(name)) {
      return errors.badRequest('Invalid filename');
    }

    const file = await env.DB.prepare(
      'SELECT id FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    )
      .bind(fileId, auth.user.id)
      .first();

    if (!file) {
      return errors.notFound('File not found');
    }

    const safeName = sanitizeFileName(name);
    await env.DB.prepare(
      'UPDATE files SET name = ?, updated_at = ? WHERE id = ?'
    )
      .bind(safeName, Date.now(), fileId)
      .run();

    return success({ message: 'File renamed successfully' });
  } catch (e) {
    console.error('Rename error:', e);
    return errors.serverError('Failed to rename file');
  }
}

export async function handleDelete(request: Request, env: Env, fileId?: string): Promise<Response> {
  if (!fileId) return errors.badRequest('Missing file ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!isValidUUID(fileId)) {
    return errors.badRequest('Invalid file ID');
  }

  try {
    const file = await env.DB.prepare(
      'SELECT id, parent_id, type FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    )
      .bind(fileId, auth.user.id)
      .first<{ id: string; parent_id: string | null; type: string }>();

    if (!file) {
      return errors.notFound('File not found');
    }

    const now = Date.now();

    if (file.type === 'folder') {
      await deleteRecursive(env, auth.user.id, fileId, now, file.parent_id);
    } else {
      await env.DB.prepare(
        'UPDATE files SET deleted_at = ?, original_parent_id = parent_id, updated_at = ? WHERE id = ?'
      )
        .bind(now, now, fileId)
        .run();
    }

    return success({ message: 'Moved to trash' });
  } catch (e) {
    console.error('Delete error:', e);
    return errors.serverError('Failed to delete');
  }
}

async function deleteRecursive(
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
    'SELECT id, type FROM files WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL'
  )
    .bind(folderId, userId)
    .all<{ id: string; type: string }>();

  if (children) {
    for (const child of children) {
      if (child.type === 'folder') {
        await deleteRecursive(env, userId, child.id, deletedAt, folderId);
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

export async function handleMove(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    const body = await request.json<{ ids: string[]; target_id: string | null }>();
    const { ids, target_id } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return errors.badRequest('No files selected');
    }

    if (target_id !== null) {
      if (!isValidUUID(target_id)) {
        return errors.badRequest('Invalid target folder ID');
      }

      const targetFolder = await env.DB.prepare(
        'SELECT id FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
      )
        .bind(target_id, auth.user.id, 'folder')
        .first();

      if (!targetFolder) {
        return errors.notFound('Target folder not found');
      }

      if (ids.includes(target_id)) {
        return errors.badRequest('Cannot move folder into itself');
      }
    }

    const now = Date.now();
    const statements = ids.map((id) =>
      env.DB.prepare(
        'UPDATE files SET parent_id = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
      ).bind(target_id, now, id, auth.user.id)
    );

    await env.DB.batch(statements);

    return success({ message: 'Files moved successfully' });
  } catch (e) {
    console.error('Move error:', e);
    return errors.serverError('Failed to move files');
  }
}

export async function handleGetContent(request: Request, env: Env, fileId?: string): Promise<Response> {
  if (!fileId) return errors.badRequest('Missing file ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!isValidUUID(fileId)) {
    return errors.badRequest('Invalid file ID');
  }

  try {
    const file = await env.DB.prepare(
      'SELECT r2_key, mime_type, size FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(fileId, auth.user.id, 'file')
      .first<{ r2_key: string; mime_type: string; size: number }>();

    if (!file) {
      return errors.notFound('File not found');
    }

    if (file.size > 5 * 1024 * 1024) {
      return errors.badRequest('File too large to edit (max 5MB)');
    }

    const obj = await env.R2.get(file.r2_key);
    if (!obj) {
      return errors.notFound('File not found in storage');
    }

    const content = await obj.text();
    return success({ content, mime_type: file.mime_type });
  } catch (e) {
    console.error('Get content error:', e);
    return errors.serverError('Failed to get file content');
  }
}

export async function handleSaveContent(request: Request, env: Env, fileId?: string): Promise<Response> {
  if (!fileId) return errors.badRequest('Missing file ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!isValidUUID(fileId)) {
    return errors.badRequest('Invalid file ID');
  }

  try {
    const body = await request.json<{ content: string }>();
    const { content } = body;

    if (typeof content !== 'string') {
      return errors.badRequest('Invalid content');
    }

    const file = await env.DB.prepare(
      'SELECT r2_key, size FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(fileId, auth.user.id, 'file')
      .first<{ r2_key: string; size: number }>();

    if (!file) {
      return errors.notFound('File not found');
    }

    const newSize = new Blob([content]).size;
    const sizeDiff = newSize - file.size;

    if (auth.user.storage_used + sizeDiff > auth.user.storage_quota) {
      return errors.quotaExceeded();
    }

    await env.R2.put(file.r2_key, content);

    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE files SET size = ?, updated_at = ? WHERE id = ?'
      ).bind(newSize, now, fileId),
      env.DB.prepare(
        'UPDATE users SET storage_used = storage_used + ?, updated_at = ? WHERE id = ?'
      ).bind(sizeDiff, now, auth.user.id),
    ]);

    return success({ message: 'File saved successfully', size: newSize });
  } catch (e) {
    console.error('Save content error:', e);
    return errors.serverError('Failed to save file');
  }
}

export async function handlePreview(request: Request, env: Env, fileId?: string): Promise<Response> {
  if (!fileId) return errors.badRequest('Missing file ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!isValidUUID(fileId)) {
    return errors.badRequest('Invalid file ID');
  }

  try {
    const file = await env.DB.prepare(
      'SELECT name, r2_key, mime_type, size FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(fileId, auth.user.id, 'file')
      .first<{ name: string; r2_key: string; mime_type: string; size: number }>();

    if (!file) {
      return errors.notFound('File not found');
    }

    const obj = await env.R2.get(file.r2_key);
    if (!obj) {
      return errors.notFound('File not found in storage');
    }

    const headers = new Headers();
    headers.set('Content-Type', file.mime_type || 'application/octet-stream');
    headers.set('Content-Length', String(obj.size));
    headers.set('Cache-Control', 'private, max-age=3600');

    if (request.headers.get('Range')) {
      const range = request.headers.get('Range')!;
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1]);
        const end = match[2] ? parseInt(match[2]) : obj.size - 1;
        
        const rangeObj = await env.R2.get(file.r2_key, {
          range: { offset: start, length: end - start + 1 },
        });
        
        if (rangeObj) {
          headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
          headers.set('Content-Length', String(end - start + 1));
          return new Response(rangeObj.body, { status: 206, headers });
        }
      }
    }

    return new Response(obj.body, { headers });
  } catch (e) {
    console.error('Preview error:', e);
    return errors.serverError('Failed to preview file');
  }
}
