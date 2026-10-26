import type { JwtPayload } from './jwt';

/** 写入 jti 黑名单后该 token 立即失效，直到自身过期为止 */
export async function revokeToken(env: Env, payload: JwtPayload): Promise<void> {
  const now = Date.now();

  await env.DB.prepare(
    'INSERT OR IGNORE INTO revoked_tokens (jti, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(payload.jti, payload.sub, payload.exp * 1000, now)
    .run();

  // 过期记录已无意义，按 2% 概率顺带清理，不依赖定时任务
  if (Math.random() < 0.02) {
    await env.DB.prepare('DELETE FROM revoked_tokens WHERE expires_at < ?')
      .bind(now)
      .run()
      .catch(() => undefined);
  }
}

/**
 * 用户级吊销：版本号 +1 后，此前签发的所有 token 在下次请求时失效。
 * 返回新版本号，供调用方给当前设备补发 token。
 */
export async function bumpTokenVersion(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ? RETURNING token_version'
  )
    .bind(Date.now(), userId)
    .first<{ token_version: number }>();

  return row?.token_version ?? 0;
}

/** 读取当前版本号，用于登录时签发 */
export async function getTokenVersion(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT token_version FROM users WHERE id = ?')
    .bind(userId)
    .first<{ token_version: number }>();

  return row?.token_version ?? 0;
}
