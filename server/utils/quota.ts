/**
 * 存储配额操作
 *
 * 所有配额变更都走条件 UPDATE，依赖 D1 的单语句原子性避免并发超卖。
 * 绝不要用「先读 storage_used 再无条件累加」的写法。
 */

export async function consumeQuota(
  env: Env,
  userId: string,
  delta: number,
  now: number
): Promise<boolean> {
  if (delta === 0) return true;

  try {
    const result = await env.DB.prepare(
      `UPDATE users SET storage_used = storage_used + ?, updated_at = ?
       WHERE id = ? AND storage_used + ? <= storage_quota`
    )
      .bind(delta, now, userId, delta)
      .run();

    return (result.meta.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function releaseQuota(
  env: Env,
  userId: string,
  delta: number,
  now: number
): Promise<void> {
  if (delta <= 0) return;

  try {
    await env.DB.prepare(
      `UPDATE users SET storage_used = MAX(storage_used - ?, 0), updated_at = ?
       WHERE id = ?`
    )
      .bind(delta, now, userId)
      .run();
  } catch {
    // 释放失败不应阻断主流程，仅在日志中记录
    console.error('Failed to release quota', { userId, delta });
  }
}
