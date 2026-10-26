import { describe, it, expect, vi } from 'vitest';
import { consumeQuota, releaseQuota } from './quota';

interface FakeOptions {
  changes?: number;
  fail?: boolean;
}

function fakeEnv(options: FakeOptions = {}) {
  const run = vi.fn(async () => {
    if (options.fail) throw new Error('db unavailable');
    return { meta: { changes: options.changes ?? 1 } };
  });
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));

  return { env: { DB: { prepare } } as unknown as Env, prepare, bind, run };
}

describe('consumeQuota', () => {
  it('条件更新命中时返回 true', async () => {
    const { env, run } = fakeEnv({ changes: 1 });
    expect(await consumeQuota(env, 'user-1', 1024, 1_700_000_000_000)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('条件不满足（changes=0）时返回 false，用于拒绝超配额写入', async () => {
    const { env } = fakeEnv({ changes: 0 });
    expect(await consumeQuota(env, 'user-1', 1024, 1)).toBe(false);
  });

  it('数据库异常时按失败处理，绝不误判为成功', async () => {
    const { env } = fakeEnv({ fail: true });
    expect(await consumeQuota(env, 'user-1', 1024, 1)).toBe(false);
  });

  it('delta 为 0 时短路，不访问数据库', async () => {
    const { env, prepare } = fakeEnv();
    expect(await consumeQuota(env, 'user-1', 0, 1)).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('releaseQuota', () => {
  it('正常释放', async () => {
    const { env, run } = fakeEnv();
    await releaseQuota(env, 'user-1', 1024, 1);
    expect(run).toHaveBeenCalledOnce();
  });

  it('非正数不产生任何更新（避免负向扣减变成增加）', async () => {
    const { env, prepare } = fakeEnv();
    await releaseQuota(env, 'user-1', 0, 1);
    await releaseQuota(env, 'user-1', -100, 1);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('释放失败不抛错，不阻断主流程', async () => {
    const { env } = fakeEnv({ fail: true });
    await expect(releaseQuota(env, 'user-1', 1024, 1)).resolves.toBeUndefined();
  });
});
