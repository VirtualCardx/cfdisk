import { hashPassword, verifyPassword } from '../utils/hash';
import { signJwt } from '../utils/jwt';
import { success, errors } from '../utils/response';
import { isValidEmail, isValidUsername, isValidPassword } from '../utils/validate';
import { authenticate, isAuthContext, type User } from '../middleware/auth';

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

    const jwtSecret = (env as unknown as { JWT_SECRET: string }).JWT_SECRET;
    const token = await signJwt({ sub: userId, role: 'user' }, jwtSecret);

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
    const body = await request.json<LoginBody>();
    const { username, password } = body;

    if (!username || !password) {
      return errors.badRequest('Missing username or password');
    }

    const user = await env.DB.prepare(
      `SELECT id, username, email, password_hash, role, storage_quota, storage_used, is_active
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

    const jwtSecret = (env as unknown as { JWT_SECRET: string }).JWT_SECRET;
    const token = await signJwt({ sub: user.id, role: user.role }, jwtSecret);

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

export async function handleLogout(_request: Request, _env: Env): Promise<Response> {
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

export async function handleChangePassword(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!isAuthContext(auth)) return auth;

  try {
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
    await env.DB.prepare(
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'
    )
      .bind(newHash, Date.now(), auth.user.id)
      .run();

    return success({ message: 'Password changed successfully' });
  } catch (e) {
    console.error('Change password error:', e);
    return errors.serverError('Failed to change password');
  }
}
