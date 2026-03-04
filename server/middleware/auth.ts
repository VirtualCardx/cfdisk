import { verifyJwt, extractToken, type JwtPayload } from '../utils/jwt';
import { errors } from '../utils/response';

export interface User {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
  storage_quota: number;
  storage_used: number;
  is_active: number;
}

export interface AuthContext {
  user: User;
  payload: JwtPayload;
}

export async function authenticate(
  request: Request,
  env: Env
): Promise<AuthContext | Response> {
  const token = extractToken(request);
  if (!token) {
    return errors.unauthorized('Missing authentication token');
  }

  const jwtSecret = (env as unknown as { JWT_SECRET: string }).JWT_SECRET;
  if (!jwtSecret) {
    return errors.serverError('JWT secret not configured');
  }

  const payload = await verifyJwt(token, jwtSecret);
  if (!payload) {
    return errors.unauthorized('Invalid or expired token');
  }

  const user = await env.DB.prepare(
    'SELECT id, username, email, role, storage_quota, storage_used, is_active FROM users WHERE id = ?'
  )
    .bind(payload.sub)
    .first<User>();

  if (!user) {
    return errors.unauthorized('User not found');
  }

  if (!user.is_active) {
    return errors.userDisabled();
  }

  return { user, payload };
}

export function requireAdmin(auth: AuthContext): Response | null {
  if (auth.user.role !== 'admin') {
    return errors.forbidden('Admin access required');
  }
  return null;
}

export function isAuthContext(result: AuthContext | Response): result is AuthContext {
  return 'user' in result;
}
