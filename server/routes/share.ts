import { success, errors } from '../utils/response';
import { authenticate, isAuthContext } from '../middleware/auth';
import { hashPassword, verifyPassword } from '../utils/hash';
import { isValidUUID, generateShareToken, getMimeType } from '../utils/validate';

interface ShareRecord {
  id: string;
  file_id: string;
  user_id: string;
  access_token: string;
  password_hash: string | null;
  expires_at: number | null;
  allowed_referers: string | null;
  download_count: number;
  max_downloads: number | null;
  created_at: number;
}

interface CreateShareBody {
  file_id: string;
  password?: string;
  expires_in?: number;
  allowed_referers?: string[];
  max_downloads?: number;
}

export async function handleCreateShare(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    const body = await request.json<CreateShareBody>();
    const { file_id, password, expires_in, allowed_referers, max_downloads } = body;

    if (!file_id || !isValidUUID(file_id)) {
      return errors.badRequest('Invalid file ID');
    }

    const file = await env.DB.prepare(
      'SELECT id, name, type FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    )
      .bind(file_id, auth.user.id)
      .first<{ id: string; name: string; type: string }>();

    if (!file) {
      return errors.notFound('File not found');
    }

    const shareId = crypto.randomUUID();
    const accessToken = generateShareToken();
    const now = Date.now();
    const expiresAt = expires_in ? now + expires_in * 1000 : null;
    const passwordHash = password ? await hashPassword(password) : null;
    const referersJson = allowed_referers?.length ? JSON.stringify(allowed_referers) : null;

    await env.DB.prepare(
      `INSERT INTO shares (id, file_id, user_id, access_token, password_hash, expires_at, allowed_referers, max_downloads, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(shareId, file_id, auth.user.id, accessToken, passwordHash, expiresAt, referersJson, max_downloads || null, now)
      .run();

    return success({
      share: {
        id: shareId,
        access_token: accessToken,
        file_name: file.name,
        file_type: file.type,
        has_password: !!password,
        expires_at: expiresAt,
        allowed_referers: allowed_referers || [],
        max_downloads: max_downloads || null,
        created_at: now,
      },
    }, 201);
  } catch (e) {
    console.error('Create share error:', e);
    return errors.serverError('Failed to create share');
  }
}

export async function handleListShares(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.access_token, s.expires_at, s.allowed_referers, s.download_count, s.max_downloads, s.created_at,
              s.password_hash IS NOT NULL as has_password, f.name as file_name, f.type as file_type
       FROM shares s
       JOIN files f ON s.file_id = f.id
       WHERE s.user_id = ?
       ORDER BY s.created_at DESC`
    )
      .bind(auth.user.id)
      .all<{
        id: string;
        access_token: string;
        expires_at: number | null;
        allowed_referers: string | null;
        download_count: number;
        max_downloads: number | null;
        created_at: number;
        has_password: number;
        file_name: string;
        file_type: string;
      }>();

    const shares = (results || []).map((s) => ({
      ...s,
      has_password: !!s.has_password,
      allowed_referers: s.allowed_referers ? JSON.parse(s.allowed_referers) : [],
    }));

    return success({ shares });
  } catch (e) {
    console.error('List shares error:', e);
    return errors.serverError('Failed to list shares');
  }
}

export async function handleDeleteShare(request: Request, env: Env, shareId?: string): Promise<Response> {
  if (!shareId) return errors.badRequest('Missing share ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  if (!isValidUUID(shareId)) {
    return errors.badRequest('Invalid share ID');
  }

  try {
    const result = await env.DB.prepare(
      'DELETE FROM shares WHERE id = ? AND user_id = ?'
    )
      .bind(shareId, auth.user.id)
      .run();

    if (!result.meta.changes) {
      return errors.notFound('Share not found');
    }

    return success({ message: 'Share deleted successfully' });
  } catch (e) {
    console.error('Delete share error:', e);
    return errors.serverError('Failed to delete share');
  }
}

export async function handleAccessShare(request: Request, env: Env, token?: string): Promise<Response> {
  if (!token) return errors.badRequest('Missing token');
  try {
    const share = await env.DB.prepare(
      `SELECT s.*, f.name as file_name, f.type as file_type, f.mime_type, f.size
       FROM shares s
       JOIN files f ON s.file_id = f.id
       WHERE s.access_token = ? AND f.deleted_at IS NULL`
    )
      .bind(token)
      .first<ShareRecord & { file_name: string; file_type: string; mime_type: string; size: number }>();

    if (!share) {
      return errors.notFound('Share not found');
    }

    if (share.expires_at && share.expires_at < Date.now()) {
      return errors.shareExpired();
    }

    if (share.max_downloads && share.download_count >= share.max_downloads) {
      return errors.shareExpired();
    }

    const needsPassword = !!share.password_hash;

    return success({
      share: {
        file_name: share.file_name,
        file_type: share.file_type,
        mime_type: share.mime_type,
        size: share.size,
        needs_password: needsPassword,
        expires_at: share.expires_at,
      },
    });
  } catch (e) {
    console.error('Access share error:', e);
    return errors.serverError('Failed to access share');
  }
}

export async function handleVerifySharePassword(request: Request, env: Env, token?: string): Promise<Response> {
  if (!token) return errors.badRequest('Missing token');
  try {
    const body = await request.json<{ password: string }>();
    const { password } = body;

    if (!password) {
      return errors.badRequest('Password required');
    }

    const share = await env.DB.prepare(
      'SELECT password_hash FROM shares WHERE access_token = ?'
    )
      .bind(token)
      .first<{ password_hash: string | null }>();

    if (!share) {
      return errors.notFound('Share not found');
    }

    if (!share.password_hash) {
      return success({ verified: true });
    }

    const valid = await verifyPassword(password, share.password_hash);
    if (!valid) {
      return errors.badRequest('Incorrect password');
    }

    return success({ verified: true });
  } catch (e) {
    console.error('Verify share password error:', e);
    return errors.serverError('Failed to verify password');
  }
}

export async function handleShareDownload(request: Request, env: Env, token?: string): Promise<Response> {
  if (!token) return errors.badRequest('Missing token');
  try {
    const share = await env.DB.prepare(
      `SELECT s.*, f.name as file_name, f.r2_key, f.mime_type
       FROM shares s
       JOIN files f ON s.file_id = f.id
       WHERE s.access_token = ? AND f.deleted_at IS NULL AND f.type = 'file'`
    )
      .bind(token)
      .first<ShareRecord & { file_name: string; r2_key: string; mime_type: string }>();

    if (!share) {
      return errors.notFound('Share not found');
    }

    if (share.expires_at && share.expires_at < Date.now()) {
      return errors.shareExpired();
    }

    if (share.max_downloads && share.download_count >= share.max_downloads) {
      return errors.shareExpired();
    }

    if (share.allowed_referers) {
      const referer = request.headers.get('Referer');
      const allowedReferers: string[] = JSON.parse(share.allowed_referers);

      if (allowedReferers.length > 0) {
        if (!referer) {
          return errors.refererNotAllowed();
        }

        try {
          const refererHost = new URL(referer).hostname;
          const isAllowed = allowedReferers.some((allowed) => {
            if (allowed.startsWith('*.')) {
              const domain = allowed.slice(2);
              return refererHost === domain || refererHost.endsWith('.' + domain);
            }
            return refererHost === allowed;
          });

          if (!isAllowed) {
            return errors.refererNotAllowed();
          }
        } catch {
          return errors.refererNotAllowed();
        }
      }
    }

    const url = new URL(request.url);
    const passwordVerified = url.searchParams.get('verified');

    if (share.password_hash && passwordVerified !== 'true') {
      return errors.sharePasswordRequired();
    }

    const obj = await env.R2.get(share.r2_key);
    if (!obj) {
      return errors.notFound('File not found in storage');
    }

    await env.DB.prepare(
      'UPDATE shares SET download_count = download_count + 1 WHERE id = ?'
    )
      .bind(share.id)
      .run();

    const headers = new Headers();
    headers.set('Content-Type', share.mime_type || 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(share.file_name)}"`);
    headers.set('Content-Length', String(obj.size));

    return new Response(obj.body, { headers });
  } catch (e) {
    console.error('Share download error:', e);
    return errors.serverError('Failed to download');
  }
}

export async function handleSharePreview(request: Request, env: Env, token?: string): Promise<Response> {
  if (!token) return errors.badRequest('Missing token');
  try {
    const share = await env.DB.prepare(
      `SELECT s.*, f.name as file_name, f.r2_key, f.mime_type, f.size as file_size
       FROM shares s
       JOIN files f ON s.file_id = f.id
       WHERE s.access_token = ? AND f.deleted_at IS NULL AND f.type = 'file'`
    )
      .bind(token)
      .first<ShareRecord & { file_name: string; r2_key: string; mime_type: string; file_size: number }>();

    if (!share) {
      return errors.notFound('Share not found');
    }

    if (share.expires_at && share.expires_at < Date.now()) {
      return errors.shareExpired();
    }

    if (share.allowed_referers) {
      const referer = request.headers.get('Referer');
      const allowedReferers: string[] = JSON.parse(share.allowed_referers);

      if (allowedReferers.length > 0 && referer) {
        try {
          const refererHost = new URL(referer).hostname;
          const isAllowed = allowedReferers.some((allowed) => {
            if (allowed.startsWith('*.')) {
              const domain = allowed.slice(2);
              return refererHost === domain || refererHost.endsWith('.' + domain);
            }
            return refererHost === allowed;
          });

          if (!isAllowed) {
            return errors.refererNotAllowed();
          }
        } catch {
          return errors.refererNotAllowed();
        }
      }
    }

    const url = new URL(request.url);
    const passwordVerified = url.searchParams.get('verified');

    if (share.password_hash && passwordVerified !== 'true') {
      return errors.sharePasswordRequired();
    }

    const obj = await env.R2.get(share.r2_key);
    if (!obj) {
      return errors.notFound('File not found in storage');
    }

    const headers = new Headers();
    headers.set('Content-Type', share.mime_type || 'application/octet-stream');
    headers.set('Content-Length', String(obj.size));
    headers.set('Cache-Control', 'private, max-age=3600');

    if (request.headers.get('Range')) {
      const range = request.headers.get('Range')!;
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1]);
        const end = match[2] ? parseInt(match[2]) : share.file_size - 1;
        
        const rangeObj = await env.R2.get(share.r2_key, {
          range: { offset: start, length: end - start + 1 },
        });
        
        if (rangeObj) {
          headers.set('Content-Range', `bytes ${start}-${end}/${share.file_size}`);
          headers.set('Content-Length', String(end - start + 1));
          return new Response(rangeObj.body, { status: 206, headers });
        }
      }
    }

    return new Response(obj.body, { headers });
  } catch (e) {
    console.error('Share preview error:', e);
    return errors.serverError('Failed to preview');
  }
}
