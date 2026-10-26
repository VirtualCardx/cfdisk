import { success, errors } from '../utils/response';
import { authenticate, isAuthContext } from '../middleware/auth';
import { isValidUUID } from '../utils/validate';
import { buildThumbUrl, getThumbSecret, safeEqual, thumbSignature } from '../utils/thumb';

/** 缩略图上限 512KB：320px WebP 通常在 10–30KB，超过说明前端生成出了问题 */
const MAX_THUMB_BYTES = 512 * 1024;

/** 只接受浏览器 canvas 能产出的无损/有损位图，拒绝 SVG（同源内联可执行脚本） */
const ALLOWED_THUMB_TYPES = new Set(['image/webp', 'image/jpeg']);

/** 缩略图 URL 绑定对象键，内容变了键就变，因此可以长缓存 + immutable */
const THUMB_CACHE_CONTROL = 'private, max-age=604800, immutable';

/**
 * GET /api/files/:id/thumb?s=<sig>
 *
 * 不带 Authorization —— `<img src>` 没法加请求头。鉴权由签名承担：
 * 签名绑定 userId + fileId + 缩略图对象键，无法跨用户伪造。
 */
export async function handleGetThumb(
  request: Request,
  env: Env,
  fileId?: string
): Promise<Response> {
  if (!fileId || !isValidUUID(fileId)) {
    return errors.badRequest('Invalid file ID');
  }

  const sig = new URL(request.url).searchParams.get('s');
  if (!sig) {
    return errors.unauthorized('Missing thumbnail signature');
  }

  const secret = getThumbSecret(env);
  if (!secret) {
    return errors.serverError('JWT secret not configured');
  }

  try {
    const file = await env.DB.prepare(
      'SELECT user_id, thumb_r2_key FROM files WHERE id = ? AND deleted_at IS NULL'
    )
      .bind(fileId)
      .first<{ user_id: string; thumb_r2_key: string | null }>();

    if (!file || !file.thumb_r2_key) {
      return errors.notFound('Thumbnail not found');
    }

    const expected = await thumbSignature(secret, file.user_id, fileId, file.thumb_r2_key);
    if (!safeEqual(expected, sig)) {
      return errors.unauthorized('Invalid thumbnail signature');
    }

    const obj = await env.R2.get(file.thumb_r2_key);
    if (!obj) {
      return errors.notFound('Thumbnail not found in storage');
    }

    const headers = new Headers();
    headers.set('Content-Type', obj.httpMetadata?.contentType || 'image/webp');
    headers.set('Content-Length', String(obj.size));
    headers.set('Cache-Control', THUMB_CACHE_CONTROL);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('ETag', obj.httpEtag);

    // 长缓存下仍可能有强制刷新（F5），命中 ETag 直接 304，省掉对象传输
    if (request.headers.get('If-None-Match') === obj.httpEtag) {
      return new Response(null, { status: 304, headers });
    }

    return new Response(obj.body, { headers });
  } catch (e) {
    console.error('Thumbnail error:', e);
    return errors.serverError('Failed to load thumbnail');
  }
}

/**
 * PUT /api/files/:id/thumb
 * body: multipart/form-data, 字段名 `thumb`
 *
 * 前端上传成功后（以及历史文件首次滚动到视口时）生成并回传，
 * 之后列表页只加载这个小对象。
 */
export async function handleUploadThumb(
  request: Request,
  env: Env,
  fileId?: string
): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!fileId || !isValidUUID(fileId)) {
    return errors.badRequest('Invalid file ID');
  }

  try {
    const file = await env.DB.prepare(
      'SELECT id, thumb_r2_key FROM files WHERE id = ? AND user_id = ? AND type = ? AND deleted_at IS NULL'
    )
      .bind(fileId, auth.user.id, 'file')
      .first<{ id: string; thumb_r2_key: string | null }>();

    if (!file) {
      return errors.notFound('File not found');
    }

    const formData = await request.formData();
    const thumb = formData.get('thumb');

    if (!(thumb instanceof File)) {
      return errors.badRequest('Missing thumbnail');
    }

    if (!ALLOWED_THUMB_TYPES.has(thumb.type)) {
      return errors.badRequest('Unsupported thumbnail type');
    }

    if (thumb.size === 0 || thumb.size > MAX_THUMB_BYTES) {
      return errors.badRequest('Thumbnail size out of range');
    }

    const ext = thumb.type === 'image/jpeg' ? 'jpg' : 'webp';
    const now = Date.now();
    const thumbKey = `thumb/${auth.user.id}/${fileId}-${now}.${ext}`;

    await env.R2.put(thumbKey, await thumb.arrayBuffer(), {
      httpMetadata: {
        contentType: thumb.type,
        cacheControl: THUMB_CACHE_CONTROL,
      },
    });

    try {
      await env.DB.prepare('UPDATE files SET thumb_r2_key = ? WHERE id = ? AND user_id = ?')
        .bind(thumbKey, fileId, auth.user.id)
        .run();
    } catch (e) {
      // 数据库写失败就把刚放上去的对象删掉，避免留下孤儿
      await env.R2.delete(thumbKey).catch(() => undefined);
      throw e;
    }

    // 旧版本对象（文件名带时间戳，每次生成都是新键）顺手清掉
    if (file.thumb_r2_key && file.thumb_r2_key !== thumbKey) {
      await env.R2.delete(file.thumb_r2_key).catch(() => undefined);
    }

    const thumbUrl = await buildThumbUrl(env, auth.user.id, fileId, thumbKey);
    return success({ thumb_url: thumbUrl });
  } catch (e) {
    console.error('Upload thumbnail error:', e);
    return errors.serverError('Failed to save thumbnail');
  }
}
