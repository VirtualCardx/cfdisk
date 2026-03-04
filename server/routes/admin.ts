import { success, errors } from '../utils/response';
import { authenticate, isAuthContext, requireAdmin } from '../middleware/auth';
import { isValidUUID, generateInviteCode } from '../utils/validate';

interface UserRecord {
  id: string;
  username: string;
  email: string;
  role: string;
  storage_quota: number;
  storage_used: number;
  is_active: number;
  created_at: number;
}

interface InviteCodeRecord {
  id: string;
  code: string;
  created_by: string;
  used_by: string | null;
  expires_at: number | null;
  created_at: number;
  used_at: number | null;
  creator_username?: string;
  user_username?: string;
}

export async function handleListUsers(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, username, email, role, storage_quota, storage_used, is_active, created_at
       FROM users ORDER BY created_at DESC`
    )
      .all<UserRecord>();

    return success({ users: results || [] });
  } catch (e) {
    console.error('List users error:', e);
    return errors.serverError('Failed to list users');
  }
}

export async function handleSetUserQuota(request: Request, env: Env, userId?: string): Promise<Response> {
  if (!userId) return errors.badRequest('Missing user ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  if (!isValidUUID(userId)) {
    return errors.badRequest('Invalid user ID');
  }

  try {
    const body = await request.json<{ quota: number }>();
    const { quota } = body;

    if (typeof quota !== 'number' || quota < 0) {
      return errors.badRequest('Invalid quota value');
    }

    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
      .bind(userId)
      .first();

    if (!user) {
      return errors.notFound('User not found');
    }

    await env.DB.prepare(
      'UPDATE users SET storage_quota = ?, updated_at = ? WHERE id = ?'
    )
      .bind(quota, Date.now(), userId)
      .run();

    return success({ message: 'User quota updated' });
  } catch (e) {
    console.error('Set quota error:', e);
    return errors.serverError('Failed to update quota');
  }
}

export async function handleSetUserStatus(request: Request, env: Env, userId?: string): Promise<Response> {
  if (!userId) return errors.badRequest('Missing user ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  if (!isValidUUID(userId)) {
    return errors.badRequest('Invalid user ID');
  }

  if (userId === auth.user.id) {
    return errors.badRequest('Cannot change your own status');
  }

  try {
    const body = await request.json<{ is_active: boolean }>();
    const { is_active } = body;

    if (typeof is_active !== 'boolean') {
      return errors.badRequest('Invalid status value');
    }

    const user = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?')
      .bind(userId)
      .first<{ id: string; role: string }>();

    if (!user) {
      return errors.notFound('User not found');
    }

    if (user.role === 'admin') {
      return errors.badRequest('Cannot disable admin accounts');
    }

    await env.DB.prepare(
      'UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?'
    )
      .bind(is_active ? 1 : 0, Date.now(), userId)
      .run();

    return success({ message: is_active ? 'User enabled' : 'User disabled' });
  } catch (e) {
    console.error('Set status error:', e);
    return errors.serverError('Failed to update status');
  }
}

export async function handleCreateInviteCode(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  try {
    const body: { expires_in?: number; count?: number } = await request.json<{ expires_in?: number; count?: number }>().catch(() => ({}));
    const expires_in = body.expires_in;
    const count = body.count ?? 1;

    if (count < 1 || count > 100) {
      return errors.badRequest('Count must be between 1 and 100');
    }

    const now = Date.now();
    const expiresAt = expires_in ? now + expires_in * 1000 : null;
    const codes: string[] = [];

    const statements = [];
    for (let i = 0; i < count; i++) {
      const id = crypto.randomUUID();
      const code = generateInviteCode();
      codes.push(code);
      statements.push(
        env.DB.prepare(
          'INSERT INTO invite_codes (id, code, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, code, auth.user.id, expiresAt, now)
      );
    }

    await env.DB.batch(statements);

    return success({ codes, expires_at: expiresAt }, 201);
  } catch (e) {
    console.error('Create invite code error:', e);
    return errors.serverError('Failed to create invite code');
  }
}

export async function handleListInviteCodes(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  try {
    const { results } = await env.DB.prepare(
      `SELECT ic.id, ic.code, ic.expires_at, ic.created_at, ic.used_at,
              c.username as creator_username, u.username as user_username
       FROM invite_codes ic
       LEFT JOIN users c ON ic.created_by = c.id
       LEFT JOIN users u ON ic.used_by = u.id
       ORDER BY ic.created_at DESC`
    )
      .all<InviteCodeRecord>();

    const codes = (results || []).map((code) => ({
      ...code,
      is_used: !!code.user_username,
      is_expired: code.expires_at ? code.expires_at < Date.now() : false,
    }));

    return success({ codes });
  } catch (e) {
    console.error('List invite codes error:', e);
    return errors.serverError('Failed to list invite codes');
  }
}

export async function handleDeleteInviteCode(request: Request, env: Env, codeId?: string): Promise<Response> {
  if (!codeId) return errors.badRequest('Missing code ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  if (!isValidUUID(codeId)) {
    return errors.badRequest('Invalid code ID');
  }

  try {
    const code = await env.DB.prepare(
      'SELECT used_by FROM invite_codes WHERE id = ?'
    )
      .bind(codeId)
      .first<{ used_by: string | null }>();

    if (!code) {
      return errors.notFound('Invite code not found');
    }

    if (code.used_by) {
      return errors.badRequest('Cannot delete a used invite code');
    }

    await env.DB.prepare('DELETE FROM invite_codes WHERE id = ?')
      .bind(codeId)
      .run();

    return success({ message: 'Invite code deleted' });
  } catch (e) {
    console.error('Delete invite code error:', e);
    return errors.serverError('Failed to delete invite code');
  }
}

export async function handleGetStats(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  try {
    const [userStats, fileStats, shareStats] = await Promise.all([
      env.DB.prepare(
        `SELECT COUNT(*) as total_users,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_users,
                SUM(storage_used) as total_storage_used
         FROM users`
      ).first<{ total_users: number; active_users: number; total_storage_used: number }>(),
      env.DB.prepare(
        `SELECT COUNT(*) as total_files,
                SUM(CASE WHEN type = 'file' THEN 1 ELSE 0 END) as files_count,
                SUM(CASE WHEN type = 'folder' THEN 1 ELSE 0 END) as folders_count,
                SUM(size) as total_size
         FROM files WHERE deleted_at IS NULL`
      ).first<{ total_files: number; files_count: number; folders_count: number; total_size: number }>(),
      env.DB.prepare('SELECT COUNT(*) as total_shares FROM shares').first<{ total_shares: number }>(),
    ]);

    return success({
      stats: {
        users: {
          total: userStats?.total_users || 0,
          active: userStats?.active_users || 0,
          total_storage_used: userStats?.total_storage_used || 0,
        },
        files: {
          total: fileStats?.total_files || 0,
          files: fileStats?.files_count || 0,
          folders: fileStats?.folders_count || 0,
          total_size: fileStats?.total_size || 0,
        },
        shares: {
          total: shareStats?.total_shares || 0,
        },
      },
    });
  } catch (e) {
    console.error('Get stats error:', e);
    return errors.serverError('Failed to get stats');
  }
}

export async function handleSetUserRole(request: Request, env: Env, userId?: string): Promise<Response> {
  if (!userId) return errors.badRequest('Missing user ID');
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  if (!isValidUUID(userId)) {
    return errors.badRequest('Invalid user ID');
  }

  if (userId === auth.user.id) {
    return errors.badRequest('Cannot change your own role');
  }

  try {
    const body = await request.json<{ role: 'admin' | 'user' }>();
    const { role } = body;

    if (role !== 'admin' && role !== 'user') {
      return errors.badRequest('Invalid role');
    }

    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
      .bind(userId)
      .first();

    if (!user) {
      return errors.notFound('User not found');
    }

    await env.DB.prepare(
      'UPDATE users SET role = ?, updated_at = ? WHERE id = ?'
    )
      .bind(role, Date.now(), userId)
      .run();

    return success({ message: 'User role updated' });
  } catch (e) {
    console.error('Set role error:', e);
    return errors.serverError('Failed to update role');
  }
}
