import { hashPassword, verifyPassword } from '../utils/hash';
import { signJwt, TOKEN_TTL_SECONDS } from '../utils/jwt';
import { success, errors } from '../utils/response';
import { getJwtSecret } from '../utils/env';
import { isValidEmail, isValidUsername, isValidPassword } from '../utils/validate';
import { authenticate, isAuthContext, type User } from '../middleware/auth';
import { rateLimit, clientIp } from '../utils/ratelimit';
import { revokeToken, bumpTokenVersion } from '../utils/session';

interface RegisterBody {
  username: string;
  email: string;
  password: string;
  invite_code: string;
}

interface LoginBody {
  username: string;
  password: string;
}

interface ChangePasswordBody {
  old_password: string;
  new_password: string;
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  try {
    const limit = await rateLimit(env, `register:${clientIp(request)}`, 5, 3600);
    if (!limit.allowed) return errors.rateLimited(limit.retryAfter);

    const body = await request.json<RegisterBody>();
    const { username, email, password, invite_code } = body;

    if (!username || !email || !password || !invite_code) {
      return errors.badRequest('Missing required fields');
    }

    if (!isValidUsername(username)) {
      return errors.badRequest('Invalid username (3-32 chars, alphanumeric and underscore only)');
    }

    if (!isValidEmail(email)) {
      return errors.badRequest('Invalid email format');
    }

    if (!isValidPassword(password)) {
      return errors.badRequest('Password must be 6-128 characters');
    }

    const inviteCode = await env.DB.prepare(
      'SELECT id, created_by, expires_at, used_by FROM invite_codes WHERE code = ?'
    )
      .bind(invite_code.toUpperCase())
      .first<{ id: string; created_by: string; expires_at: number | null; used_by: string | null }>();

    if (!inviteCode) {
      return errors.invalidInviteCode();
    }

    if (inviteCode.used_by) {
      return errors.invalidInviteCode();
    }

    if (inviteCode.expires_at && inviteCode.expires_at < Date.now()) {
      return errors.invalidInviteCode();
    }

    const existingUser = await env.DB.prepare(
      'SELECT id FROM users WHERE username = ? OR email = ?'
    )
      .bind(username.toLowerCase(), email.toLowerCase())
      .first();

    if (existingUser) {
      return errors.conflict('Username or email already exists');
    }

    const userId = crypto.randomUUID();
    const now = Date.now();
    const passwordHash = await hashPassword(password);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, username, email, password_hash, role, invited_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`
      ).bind(userId, username.toLowerCase(), email.toLowerCase(), passwordHash, inviteCode.created_by, now, now),
      env.DB.prepare(
        'UPDATE invite_codes SET used_by = ?, used_at = ? WHERE id = ?'
      ).bind(userId, now, inviteCode.id),
    ]);

    const jwtSecret = getJwtSecret(env);
    if (!jwtSecret) {
      return errors.serverError('JWT secret not configured');
    }
    const token = await signJwt({ sub: userId, role: 'user', tv: 0 }, jwtSecret);

    return success({
      token,
      user: {
        id: userId,
        username: username.toLowerCase(),
        email: email.toLowerCase(),
        role: 'user',
        storage_quota: 10737418240,
        storage_used: 0,
      },
    }, 201);
  } catch (e) {
    console.error('Register error:', e);
    return errors.serverError('Registration failed');
  }
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  try {
    // 每 IP 5 分钟 10 次；PBKDF2 10 万次迭代本身也会拖慢暴力破解
    const limit = await rateLimit(env, `login:${clientIp(request)}`, 10, 300);
    if (!limit.allowed) return errors.rateLimited(limit.retryAfter);

    const body = await request.json<LoginBody>();
    const { username, password } = body;

    if (!username || !password) {
      return errors.badRequest('Missing username or password');
    }

    const user = await env.DB.prepare(
      `SELECT id, username, email, password_hash, role, storage_quota, storage_used, is_active, token_version
       FROM users WHERE username = ? OR email = ?`
    )
      .bind(username.toLowerCase(), username.toLowerCase())
      .first<User & { password_hash: string }>();

    if (!user) {
      return errors.invalidCredentials();
    }

    if (!user.is_active) {
      return errors.userDisabled();
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return errors.invalidCredentials();
    }

    const jwtSecret = getJwtSecret(env);
    if (!jwtSecret) {
      return errors.serverError('JWT secret not configured');
    }
    const token = await signJwt(
      { sub: user.id, role: user.role, tv: user.token_version },
      jwtSecret
    );

    return success({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        storage_quota: user.storage_quota,
        storage_used: user.storage_used,
      },
    });
  } catch (e) {
    console.error('Login error:', e);
    return errors.serverError('Login failed');
  }
}

/**
 * 登出：把当前 token 的 jti 写进黑名单，直到它自身过期。
 * 只影响这一台设备，其他设备上的会话仍有效。
 * 登出是幂等操作，token 已失效时同样返回成功，避免前端弹错。
 */
export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) {
    return success({ message: 'Logged out successfully' });
  }

  try {
    await revokeToken(env, auth.payload);
  } catch (e) {
    console.error('Logout error:', e);
  }

  return success({ message: 'Logged out successfully' });
}

export async function handleGetMe(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  return success({
    user: {
      id: auth.user.id,
      username: auth.user.username,
      email: auth.user.email,
      role: auth.user.role,
      storage_quota: auth.user.storage_quota,
      storage_used: auth.user.storage_used,
    },
  });
}

/**
 * 续期：用当前仍然有效的 token 换一张新的 30 天 token（滑动过期）。
 *
 * 走 authenticate，所以改密码抬高的 token_version、登出写入的 jti 黑名单、
 * 被禁用的账号都会在这里拦下，不存在"用续期绕过吊销"的漏洞。
 */
export async function handleRefresh(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    // 正常情况下几周才触发一次，限流只是防止脚本刷 token
    const limit = await rateLimit(env, `refresh:${auth.user.id}`, 30, 3600);
    if (!limit.allowed) return errors.rateLimited(limit.retryAfter);

    const jwtSecret = getJwtSecret(env);
    if (!jwtSecret) {
      return errors.serverError('JWT secret not configured');
    }

    // tv 取数据库里的最新值，避免旧 token 的版本号把新 token 带偏
    const token = await signJwt(
      { sub: auth.user.id, role: auth.user.role, tv: auth.user.token_version },
      jwtSecret
    );

    return success({
      token,
      expires_in: TOKEN_TTL_SECONDS,
      expires_at: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    });
  } catch (e) {
    console.error('Refresh error:', e);
    return errors.serverError('Token refresh failed');
  }
}

export async function handleChangePassword(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
    // 防止拿到 token 后对着旧密码反复试探
    const limit = await rateLimit(env, `password:${auth.user.id}`, 10, 3600);
    if (!limit.allowed) return errors.rateLimited(limit.retryAfter);

    const body = await request.json<ChangePasswordBody>();
    const { old_password, new_password } = body;

    if (!old_password || !new_password) {
      return errors.badRequest('Missing password fields');
    }

    if (!isValidPassword(new_password)) {
      return errors.badRequest('New password must be 6-128 characters');
    }

    const user = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?'
    )
      .bind(auth.user.id)
      .first<{ password_hash: string }>();

    if (!user) {
      return errors.notFound('User not found');
    }

    const valid = await verifyPassword(old_password, user.password_hash);
    if (!valid) {
      return errors.badRequest('Current password is incorrect');
    }

    const newHash = await hashPassword(new_password);

    // 先落新密码，再抬版本号：一旦版本变了，旧 token 全部失效
    await env.DB.prepare(
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'
    )
      .bind(newHash, Date.now(), auth.user.id)
      .run();

    const tokenVersion = await bumpTokenVersion(env, auth.user.id);

    const jwtSecret = getJwtSecret(env);
    if (!jwtSecret) {
      return errors.serverError('JWT secret not configured');
    }

    // 给当前设备补发 token，改密后不必重新登录
    const token = await signJwt(
      { sub: auth.user.id, role: auth.user.role, tv: tokenVersion },
      jwtSecret
    );

    return success({ message: 'Password changed successfully', token });
  } catch (e) {
    console.error('Change password error:', e);
    return errors.serverError('Failed to change password');
  }
}
