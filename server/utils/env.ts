/**
 * Env 访问工具
 *
 * JWT_SECRET 由 wrangler secret 注入，不在 wrangler.jsonc 的 vars 里，
 * 因此 Env 类型中不存在该字段，统一在这里做一次收窄。
 */

export function getJwtSecret(env: Env): string | null {
  const secret = (env as unknown as { JWT_SECRET?: string }).JWT_SECRET;
  return secret && secret.length > 0 ? secret : null;
}
