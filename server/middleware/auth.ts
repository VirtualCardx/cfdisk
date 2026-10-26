import { verifyJwt, extractToken, type JwtPayload } from '../utils/jwt';
import { errors } from '../utils/response';
import { getJwtSecret } from '../utils/env';

export interface User {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
  storage_quota: number;
  storage_used: number;
  is_active: number;
  token_version: number;
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

  const jwtSecret = getJwtSecret(env);
  if (!jwtSecret) {
    return errors.serverError('JWT secret not configured');
  }

  const payload = await verifyJwt(token, jwtSecret);
  if (!payload) {
    return errors.unauthorized('Invalid or expired token');
  }

  // 一次往返同时取用户信息、token 版本和 jti 黑名单命中情况
  const user = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.role, u.storage_quota, u.storage_used,
            u.is_active, u.token_version,
            EXISTS(SELECT 1 FROM revoked_tokens r WHERE r.jti = ?) AS revoked
     FROM users u WHERE u.id = ?`
  )
    .bind(payload.jti, payload.sub)
    .first<User & { revoked: number }>();

  if (!user) {
    return errors.unauthorized('User not found');
  }

  if (!user.is_active) {
    return errors.userDisabled();
  }

  // 改密码 / 改角色会让版本号 +1，此前签发的 token 全部作废
  if ((payload.tv ?? 0) !== user.token_version) {
    return errors.tokenRevoked();
  }

  // 登出写入的黑名单，只影响单个设备
  if (user.revoked) {
    return errors.tokenRevoked();
  }

  const { revoked: _revoked, ...rest } = user;
  return { user: rest, payload };
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
