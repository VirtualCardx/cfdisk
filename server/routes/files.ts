import { success, errors } from '../utils/response';
import { authenticate, isAuthContext } from '../middleware/auth';
import { isValidFileName, isValidUUID, getMimeType, sanitizeFileName } from '../utils/validate';
import { consumeQuota, releaseQuota } from '../utils/quota';
import { contentDisposition, withCharset, isActiveContent } from '../utils/http';
import { parseRange } from '../utils/range';
import { signJwt, verifyJwt, extractToken } from '../utils/jwt';
import { getJwtSecret } from '../utils/env';
import { softDeleteTree } from '../utils/trash';
import { buildThumbUrl } from '../utils/thumb';

// 预览地址有效期：视频/PDF 播放期间会持续发起 Range 请求，需要留足时间
const PREVIEW_TOKEN_TTL = 3600;

interface FileRecord {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  type: 'file' | 'folder';
  mime_type: string | null;
  size: number;
  r2_key: string | null;
  thumb_r2_key?: string | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * 给带缩略图的文件补一个可直接放进 `<img src>` 的地址。
 *
 * 地址是稳定签名的（同一版本永远相同），前端因此不需要再单独请求 token，
 * 也不会因为 URL 变化而让浏览器缓存失效。内部对象键不外泄。
 */
async function attachThumbUrls<T extends { id: string; thumb_r2_key?: string | null }>(
  env: Env,
  userId: string,
  rows: T[]
): Promise<(Omit<T, 'thumb_r2_key'> & { thumb_url: string | null })[]> {
  return Promise.all(
    rows.map(async ({ thumb_r2_key, ...rest }) => ({
      ...rest,
      thumb_url: await buildThumbUrl(env, userId, rest.id, thumb_r2_key),
    }))
  );
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
    if (parentId && !isValidUUID(parentId)) {
      return errors.badRequest('Invalid folder ID');
    }

    if (parentId) {
      const parent = await env.DB.prepare(
        'SELECT id FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
      )
        .bind(parentId, auth.user.id, 'folder')
        .first();

      if (!parent) {
        return errors.notFound('Folder not found');
      }
    }

    const query = parentId
      ? `SELECT id, parent_id, name, type, mime_type, size, thumb_r2_key, created_at, updated_at
         FROM files WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL
         ORDER BY type DESC, ${sortColumn} ${sortOrder}`
      : `SELECT id, parent_id, name, type, mime_type, size, thumb_r2_key, created_at, updated_at
         FROM files WHERE user_id = ? AND parent_id IS NULL AND deleted_at IS NULL
         ORDER BY type DESC, ${sortColumn} ${sortOrder}`;

    const stmt = parentId
      ? env.DB.prepare(query).bind(auth.user.id, parentId)
      : env.DB.prepare(query).bind(auth.user.id);

    const { results } = await stmt.all<FileRecord>();

    let path: { id: string; name: string }[] = [];
    if (parentId) {
      path = await buildPath(env, parentId, auth.user.id);
    }

    return success({
      files: await attachThumbUrls(env, auth.user.id, results || []),
      path,
    });
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

async function buildPath(
  env: Env,
  folderId: string,
  userId: string
): Promise<{ id: string; name: string }[]> {
  const path: { id: string; name: string }[] = [];
  const visited = new Set<string>();
  let currentId: string | null = folderId;

  while (currentId) {
    // 数据异常形成的环必须在这里截断，否则单次请求会一直循环到 CPU 超时
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const result: FolderPathItem | null = await env.DB.prepare(
      'SELECT id, name, parent_id FROM files WHERE id = ? AND user_id = ? AND type = ?'
    )
      .bind(currentId, userId, 'folder')
      .first();

    if (!result) break;
    path.unshift({ id: result.id, name: result.name });
    currentId = result.parent_id;

    // 路径深度保护（正常目录树不会超过 64 层）
    if (visited.size > 64) break;
  }

  return path;
}

// 说明：
// 原 /api/files/upload-url 与 /api/files/confirm 两个接口已移除。
// Workers 里的 R2 multipart 只能在同一个请求内完成 uploadPart，
// 无法向浏览器签发预签名 PUT（那需要 S3 access key），
// 因此这两端的「先取 URL 再确认」流程永远无法走通。
// 浏览器分片上传统一使用 POST /api/files/upload-chunk。

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
    const now = Date.now();

    const consumed = await consumeQuota(env, auth.user.id, file.size, now);
    if (!consumed) {
      return errors.quotaExceeded();
    }

    try {
      await env.R2.put(r2Key, file.stream(), {
        httpMetadata: { contentType: mimeType },
      });
    } catch (e) {
      await releaseQuota(env, auth.user.id, file.size, now);
      throw e;
    }

    try {
      await env.DB.prepare(
        `INSERT INTO files (id, user_id, parent_id, name, type, mime_type, size, r2_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?)`
      )
        .bind(fileId, auth.user.id, parentId, safeName, mimeType, file.size, r2Key, now, now)
        .run();
    } catch (e) {
      await env.R2.delete(r2Key).catch(() => undefined);
      await releaseQuota(env, auth.user.id, file.size, now);
      throw e;
    }

    return success({
      file: {
        id: fileId,
        name: safeName,
        type: 'file',
        mime_type: mimeType,
        size: file.size,
        created_at: now,
        updated_at: now,
        // 缩略图由前端在上传成功后单独回传，这里先给 null
        thumb_url: null,
      },
    }, 201);
  } catch (e) {
    console.error('Direct upload error:', e);
    return errors.serverError('Failed to upload file');
  }
}

/**
 * 分片上传状态
 *
 * meta 保存会话级信息（fileId / r2Key / uploadId），每个分片的 etag 各自落成独立对象
 * `parts/{index}.{etag}`。并发上传分片时不会出现「读状态 → 改 → 写回」丢 etag 的竞态，
 * 收尾时一次 list 即可拿到全部 part。
 */
interface ChunkUploadMeta {
  fileId: string;
  r2Key: string;
  uploadId: string;
  parentId: string | null;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  createdAt: number;
}

interface UploadedPart {
  index: number;
  etag: string;
  key: string;
}

// 使用 R2 存储上传状态，确保在 Cloudflare Workers 多实例间共享
const UPLOAD_STATE_PREFIX = 'upload-state/';
const PARTS_SEGMENT = 'parts/';

function uploadPrefix(userId: string, sessionId: string): string {
  return `${UPLOAD_STATE_PREFIX}${userId}:${sessionId}/`;
}

async function getUploadMeta(env: Env, prefix: string): Promise<ChunkUploadMeta | null> {
  try {
    const obj = await env.R2.get(`${prefix}meta`);
    if (!obj) return null;
    return JSON.parse(await obj.text()) as ChunkUploadMeta;
  } catch {
    return null;
  }
}

async function putUploadMeta(env: Env, prefix: string, meta: ChunkUploadMeta): Promise<void> {
  await env.R2.put(`${prefix}meta`, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function putUploadPart(env: Env, prefix: string, index: number, etag: string): Promise<void> {
  const padded = String(index).padStart(6, '0');
  await env.R2.put(`${prefix}${PARTS_SEGMENT}${padded}.${encodeURIComponent(etag)}`, '');
}

async function listUploadParts(env: Env, prefix: string): Promise<UploadedPart[]> {
  const parts: UploadedPart[] = [];
  const partsPrefix = `${prefix}${PARTS_SEGMENT}`;
  let cursor: string | undefined;

  do {
    const page = await env.R2.list({ prefix: partsPrefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const name = obj.key.slice(partsPrefix.length);
      const dot = name.indexOf('.');
      if (dot === -1) continue;

      const index = parseInt(name.slice(0, dot), 10);
      if (isNaN(index)) continue;

      parts.push({
        index,
        etag: decodeURIComponent(name.slice(dot + 1)),
        key: obj.key,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return parts;
}

async function clearUpload(env: Env, prefix: string): Promise<void> {
  const parts = await listUploadParts(env, prefix);
  const keys = [`${prefix}meta`, ...parts.map((part) => part.key)];

  // R2 单次 delete 最多 1000 个键
  for (let i = 0; i < keys.length; i += 1000) {
    await env.R2.delete(keys.slice(i, i + 1000));
  }
}

export async function handleUploadChunk(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    const formData = await request.formData();
    const chunk = formData.get('chunk') as File | null;
    const chunkIndex = parseInt(formData.get('chunkIndex') as string);
    const totalChunks = parseInt(formData.get('totalChunks') as string);
    const fileName = formData.get('fileName') as string;
    const parentId = formData.get('parent_id') as string | null;
    const sessionId = formData.get('sessionId') as string | null;

    if (!chunk || isNaN(chunkIndex) || isNaN(totalChunks) || !fileName) {
      return errors.badRequest('Missing required fields');
    }

    // 每个上传会话独立，同名同大小文件并发上传也不会共用状态
    if (!sessionId || !/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) {
      return errors.badRequest('Missing or invalid upload session id');
    }

    if (!isValidFileName(fileName)) {
      return errors.badRequest('Invalid filename');
    }

    // fileSize 为整个文件的总字节数（不是分片大小），据此做配额预检
    const declaredSize = parseInt(formData.get('fileSize') as string);
    if (isNaN(declaredSize) || declaredSize <= 0) {
      return errors.badRequest('Missing file size');
    }

    if (auth.user.storage_used + declaredSize > auth.user.storage_quota) {
      return errors.quotaExceeded();
    }

    const prefix = uploadPrefix(auth.user.id, sessionId);
    let meta = await getUploadMeta(env, prefix);

    // 只有首片负责建会话；客户端保证首片先发，避免并发创建 multipart
    if (!meta) {
      if (chunkIndex !== 0) {
        return errors.uploadSessionMissing();
      }

      // 父目录校验只在建会话时做一次：后续分片沿用 meta.parentId，
      // 不必每片都往 D1 打一次「目录是否存在」的查询（100MB 文件能省 7 次往返）
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
      const mimeType = getMimeType(fileName);
      const multipartUpload = await env.R2.createMultipartUpload(r2Key, {
        httpMetadata: { contentType: mimeType },
      });

      meta = {
        fileId,
        r2Key,
        uploadId: multipartUpload.uploadId,
        parentId,
        fileName,
        fileSize: declaredSize,
        mimeType,
        totalChunks,
        createdAt: Date.now(),
      };
      await putUploadMeta(env, prefix, meta);
    }

    if (meta.totalChunks !== totalChunks || meta.fileSize !== declaredSize) {
      return errors.badRequest('Upload state does not match this request');
    }

    // 上传分片到 R2，etag 落成独立对象（无共享状态，可并发）
    const upload = env.R2.resumeMultipartUpload(meta.r2Key, meta.uploadId);
    const r2Start = Date.now();
    const part = await upload.uploadPart(chunkIndex + 1, chunk.stream());
    const timing = { 'Server-Timing': `r2;dur=${Date.now() - r2Start}` };
    await putUploadPart(env, prefix, chunkIndex, part.etag);

    // 如果是最后一片，完成上传
    if (chunkIndex === totalChunks - 1) {
      const uploaded = await listUploadParts(env, prefix);
      if (uploaded.length !== totalChunks) {
        return errors.badRequest(`Missing chunks: ${uploaded.length}/${totalChunks} uploaded`);
      }

      // 按 chunkIndex 组装 parts
      uploaded.sort((a, b) => a.index - b.index);
      for (let i = 0; i < totalChunks; i++) {
        if (uploaded[i]?.index !== i) {
          return errors.badRequest(`Missing chunk ${i}`);
        }
      }

      // 完成分片上传
      await upload.complete(
        uploaded.map((item) => ({ partNumber: item.index + 1, etag: item.etag }))
      );

      // 获取上传后的文件信息
      const obj = await env.R2.head(meta.r2Key);
      if (!obj) {
        return errors.serverError('Failed to verify uploaded file');
      }

      const safeName = sanitizeFileName(meta.fileName);
      const now = Date.now();

      const consumed = await consumeQuota(env, auth.user.id, obj.size, now);
      if (!consumed) {
        await env.R2.delete(meta.r2Key).catch(() => undefined);
        await clearUpload(env, prefix);
        return errors.quotaExceeded();
      }

      // 保存到数据库
      try {
        await env.DB.prepare(
          `INSERT INTO files (id, user_id, parent_id, name, type, mime_type, size, r2_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?)`
        )
          .bind(meta.fileId, auth.user.id, meta.parentId, safeName, meta.mimeType, obj.size, meta.r2Key, now, now)
          .run();
      } catch (e) {
        await releaseQuota(env, auth.user.id, obj.size, now);
        throw e;
      }

      // 清理状态
      await clearUpload(env, prefix);

      // 返回完整的文件信息（直接返回，不使用 success 包装，避免嵌套）
      return Response.json({
        success: true,
        file: {
          id: meta.fileId,
          parent_id: meta.parentId,
          name: safeName,
          type: 'file',
          mime_type: meta.mimeType,
          size: obj.size,
          created_at: now,
          updated_at: now,
          thumb_url: null,
        },
      }, { status: 201, headers: timing });
    }

    // 返回分片上传成功
    return Response.json({
      success: true,
      chunkIndex,
      totalChunks,
    }, { headers: timing });
  } catch (e) {
    console.error('Upload chunk error:', e);
    return errors.serverError('Failed to upload chunk');
  }
}

export async function handleSearchFiles(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (q.length === 0) {
    return success({ query: q, files: [] });
  }

  if (q.length > 100) {
    return errors.badRequest('Search query too long');
  }

  try {
    // 转义 LIKE 通配符，避免用户输入 % 或 _ 扫全表
    const escaped = q.replace(/[\\%_]/g, (char) => `\\${char}`);

    const { results } = await env.DB.prepare(
      `SELECT id, parent_id, name, type, mime_type, size, thumb_r2_key, created_at, updated_at
       FROM files
       WHERE user_id = ? AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\'
       ORDER BY type DESC, name ASC
       LIMIT 50`
    )
      .bind(auth.user.id, `%${escaped}%`)
      .all<{
        id: string;
        parent_id: string | null;
        name: string;
        type: 'file' | 'folder';
        mime_type: string | null;
        size: number;
        thumb_r2_key: string | null;
        created_at: number;
        updated_at: number;
      }>();

    // 一次性取回所有目录，在内存里拼路径，避免每条结果都回溯一次数据库
    const { results: folders } = await env.DB.prepare(
      'SELECT id, name, parent_id FROM files WHERE user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(auth.user.id, 'folder')
      .all<{ id: string; name: string; parent_id: string | null }>();

    const folderMap = new Map((folders || []).map((folder) => [folder.id, folder]));

    const withPath = (results || []).map((item) => {
      const path: string[] = [];
      const visited = new Set<string>();
      let currentId = item.parent_id;

      while (currentId && !visited.has(currentId) && path.length < 64) {
        visited.add(currentId);
        const folder = folderMap.get(currentId);
        if (!folder) break;
        path.unshift(folder.name);
        currentId = folder.parent_id;
      }

      return { ...item, path };
    });

    return success({
      query: q,
      files: await attachThumbUrls(env, auth.user.id, withPath),
    });
  } catch (e) {
    console.error('Search error:', e);
    return errors.serverError('Failed to search files');
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
    const dbStart = Date.now();
    // 一次查出 size：Range 要靠它算边界，否则得先 R2.head 一次、多一个往返
    const file = await env.DB.prepare(
      'SELECT name, r2_key, mime_type, size FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(fileId, auth.user.id, 'file')
      .first<{ name: string; r2_key: string; mime_type: string; size: number }>();

    if (!file) {
      return errors.notFound('File not found');
    }
    const dbMs = Date.now() - dbStart;

    // 支持 Range：前端对大文件并发多段下载，吞吐比单连接高得多
    const range = request.method === 'GET' ? parseRange(request.headers.get('Range'), file.size) : null;

    const r2Start = Date.now();
    const obj = range
      ? await env.R2.get(file.r2_key, { range: { offset: range.offset, length: range.length } })
      : await env.R2.get(file.r2_key);
    const r2Ms = Date.now() - r2Start;

    if (!obj) {
      return errors.notFound('File not found in storage');
    }

    const headers = new Headers();
    headers.set('Content-Type', file.mime_type || 'application/octet-stream');
    headers.set('Content-Disposition', contentDisposition(file.name, 'attachment'));
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Accept-Ranges', 'bytes');
    // 把服务端耗时拆开暴露出来，方便在 DevTools 的 Timing 面板里区分「D1 慢」还是「R2 慢」
    headers.set('Server-Timing', `db;dur=${dbMs}, r2;dur=${r2Ms}`);

    if (range) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
      headers.set('Content-Length', String(range.length));
      return new Response(obj.body, { status: 206, headers });
    }

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
    const batchId = crypto.randomUUID();

    // 一次递归 CTE 把整棵子树打成同一批次，不再逐层 N+1 更新
    await softDeleteTree(env, auth.user.id, fileId, now, batchId);

    return success({ message: 'Moved to trash', batch_id: batchId });
  } catch (e) {
    console.error('Delete error:', e);
    return errors.serverError('Failed to delete');
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

    if (ids.some((id) => !isValidUUID(id))) {
      return errors.badRequest('Invalid file ID');
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

      // 目标目录不能是被移动文件夹本身或其子孙，否则会形成环
      const placeholders = ids.map(() => '?').join(',');
      const { results: movingFolders } = await env.DB.prepare(
        `SELECT id FROM files WHERE id IN (${placeholders}) AND user_id = ? AND type = 'folder'`
      )
        .bind(...ids, auth.user.id)
        .all<{ id: string }>();

      const movingFolderIds = new Set((movingFolders ?? []).map((f) => f.id));

      if (movingFolderIds.size > 0) {
        const seen = new Set<string>();
        let cursor: string | null = target_id;

        while (cursor) {
          if (movingFolderIds.has(cursor)) {
            return errors.badRequest('Cannot move a folder into itself or its subfolder');
          }
          if (seen.has(cursor)) break;
          seen.add(cursor);

          const row: { parent_id: string | null } | null = await env.DB.prepare(
            'SELECT parent_id FROM files WHERE id = ? AND user_id = ?'
          )
            .bind(cursor, auth.user.id)
            .first();

          cursor = row?.parent_id ?? null;
        }
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

    if (newSize > 5 * 1024 * 1024) {
      return errors.badRequest('File too large to edit (max 5MB)');
    }

    const delta = newSize - file.size;
    const now = Date.now();

    if (delta !== 0) {
      const consumed = await consumeQuota(env, auth.user.id, delta, now);
      if (!consumed) {
        return errors.quotaExceeded();
      }
    }

    try {
      await env.R2.put(file.r2_key, content);
      await env.DB.prepare('UPDATE files SET size = ?, updated_at = ? WHERE id = ?')
        .bind(newSize, now, fileId)
        .run();
    } catch (e) {
      if (delta !== 0) {
        await consumeQuota(env, auth.user.id, -delta, now);
      }
      throw e;
    }

    return success({ message: 'File saved successfully', size: newSize });
  } catch (e) {
    console.error('Save content error:', e);
    return errors.serverError('Failed to save file');
  }
}

/**
 * 预览鉴权：优先 Bearer token；<img>/<video>/<iframe> 无法携带自定义头，
 * 因此额外支持短期签名 token（?t=）。
 */
async function resolvePreviewUserId(
  request: Request,
  env: Env,
  fileId: string
): Promise<string | Response> {
  if (extractToken(request)) {
    const auth = await authenticate(request, env);
    if (!isAuthContext(auth)) return auth;
    return auth.user.id;
  }

  const token = new URL(request.url).searchParams.get('t');
  if (!token) {
    return errors.unauthorized('Missing authentication token');
  }

  const secret = getJwtSecret(env);
  if (!secret) {
    return errors.serverError('JWT secret not configured');
  }

  const payload = await verifyJwt(token, secret);
  if (!payload || payload.role !== 'preview' || payload.fid !== fileId) {
    return errors.forbidden('Invalid or expired preview token');
  }

  return payload.sub;
}

/**
 * 签发短期预览地址，供前端直接放进 img/video 的 src。
 */
export async function handleGetPreviewToken(
  request: Request,
  env: Env,
  fileId?: string
): Promise<Response> {
  if (!fileId || !isValidUUID(fileId)) {
    return errors.badRequest('Invalid file ID');
  }

  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    const file = await env.DB.prepare(
      'SELECT id FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(fileId, auth.user.id, 'file')
      .first();

    if (!file) {
      return errors.notFound('File not found');
    }

    const secret = getJwtSecret(env);
    if (!secret) {
      return errors.serverError('JWT secret not configured');
    }

    const token = await signJwt(
      { sub: auth.user.id, role: 'preview', fid: fileId },
      secret,
      PREVIEW_TOKEN_TTL
    );

    return success({
      url: `/api/files/${fileId}/preview?t=${token}`,
      expires_in: PREVIEW_TOKEN_TTL,
    });
  } catch (e) {
    console.error('Preview token error:', e);
    return errors.serverError('Failed to create preview token');
  }
}

export async function handlePreview(request: Request, env: Env, fileId?: string): Promise<Response> {
  if (!fileId) return errors.badRequest('Missing file ID');

  if (!isValidUUID(fileId)) {
    return errors.badRequest('Invalid file ID');
  }

  try {
    const userId = await resolvePreviewUserId(request, env, fileId);
    if (typeof userId !== 'string') return userId;

    const file = await env.DB.prepare(
      'SELECT name, r2_key, mime_type FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(fileId, userId, 'file')
      .first<{ name: string; r2_key: string; mime_type: string }>();

    if (!file) {
      return errors.notFound('File not found');
    }

    const obj = await env.R2.get(file.r2_key);
    if (!obj) {
      return errors.notFound('File not found in storage');
    }

    // SVG/HTML 这类可执行脚本的文件同源内联渲染会导致存储型 XSS，只能下载
    const active = isActiveContent(file.mime_type);

    const headers = new Headers();
    headers.set('Content-Type', withCharset(file.mime_type));
    headers.set('Content-Disposition', contentDisposition(file.name, active ? 'attachment' : 'inline'));
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'private, max-age=300');

    const range = parseRange(request.headers.get('Range'), obj.size);
    if (range) {
      const rangeObj = await env.R2.get(file.r2_key, {
        range: { offset: range.offset, length: range.length },
      });

      if (rangeObj) {
        headers.set('Content-Range', `bytes ${range.start}-${range.end}/${obj.size}`);
        headers.set('Content-Length', String(range.length));
        return new Response(rangeObj.body, { status: 206, headers });
      }
    }

    headers.set('Content-Length', String(obj.size));
    return new Response(obj.body, { headers });
  } catch (e) {
    console.error('Preview error:', e);
    return errors.serverError('Failed to preview file');
  }
}
