/**
 * 固定窗口限流（D1 实现）
 *
 * 单条 upsert 完成「累加 + 读取」，依赖 D1 单语句原子性，避免并发绕过。
 * 窗口按 key 独立计算：key 里应带上维度（IP、用户名、分享 token 等）。
 */

export interface RateLimitResult {
  allowed: boolean;
  /** 距离窗口重置还有多少秒，仅在 allowed=false 时有意义 */
  retryAfter: number;
}

const CLEANUP_PROBABILITY = 0.02;

export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSec: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;

  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`
    )
      .bind(key, windowStart)
      .first<{ count: number }>();

    const count = row?.count ?? 1;

    // 低概率清理过期窗口，避免表无限增长
    if (Math.random() < CLEANUP_PROBABILITY) {
      await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
        .bind(now - 24 * 60 * 60 * 1000)
        .run()
        .catch(() => undefined);
    }

    if (count > limit) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
      };
    }

    return { allowed: true, retryAfter: 0 };
  } catch (e) {
    // 限流表不可用时放行，不能因为限流设施故障把登录也堵死
    console.error('Rate limit error:', e);
    return { allowed: true, retryAfter: 0 };
  }
}

/** 取客户端 IP，Cloudflare 会注入 CF-Connecting-IP */
export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}
