import { describe, it, expect } from 'vitest';
import { thumbSignature, safeEqual, buildThumbUrl, getThumbSecret } from './thumb';

const SECRET = 'thumb-test-secret';
const USER = 'user-1';
const FILE = 'a3f1c2d4-0000-4000-8000-000000000001';
const KEY = `thumb/${USER}/${FILE}-1700000000000.webp`;

describe('thumbSignature', () => {
  it('同一版本重复签名得到相同结果（URL 才能被浏览器缓存命中）', async () => {
    const a = await thumbSignature(SECRET, USER, FILE, KEY);
    const b = await thumbSignature(SECRET, USER, FILE, KEY);
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });

  it('换了缩略图对象键（重新生成）签名随之变化', async () => {
    const a = await thumbSignature(SECRET, USER, FILE, KEY);
    const b = await thumbSignature(SECRET, USER, FILE, `${KEY}.v2`);
    expect(a).not.toBe(b);
  });

  it('不同文件 / 不同用户互不复用', async () => {
    const base = await thumbSignature(SECRET, USER, FILE, KEY);
    expect(await thumbSignature(SECRET, USER, 'other-file', KEY)).not.toBe(base);
    expect(await thumbSignature(SECRET, 'other-user', FILE, KEY)).not.toBe(base);
  });

  it('换密钥后签名失效', async () => {
    const a = await thumbSignature(SECRET, USER, FILE, KEY);
    const b = await thumbSignature('another-secret', USER, FILE, KEY);
    expect(a).not.toBe(b);
  });

  it('签名是 URL 安全的（只含 base64url 字符）', async () => {
    const sig = await thumbSignature(SECRET, USER, FILE, KEY);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('safeEqual', () => {
  it('相同字符串为真', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
  });

  it('长度或内容不同为假', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('abc', 'abc123')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('buildThumbUrl', () => {
  const env = { JWT_SECRET: SECRET } as unknown as Env;

  it('没有缩略图对象时返回 null', async () => {
    expect(await buildThumbUrl(env, USER, FILE, null)).toBeNull();
    expect(await buildThumbUrl(env, USER, FILE, undefined)).toBeNull();
  });

  it('有对象时返回带签名的相对地址', async () => {
    const url = await buildThumbUrl(env, USER, FILE, KEY);
    expect(url).toBeTruthy();
    expect(url!.startsWith(`/api/files/${FILE}/thumb?s=`)).toBe(true);

    const sig = url!.split('s=')[1]!;
    expect(sig).toBe(await thumbSignature(SECRET, USER, FILE, KEY));
  });

  it('未配置密钥时降级为 null（不抛错，不影响列表）', async () => {
    expect(await buildThumbUrl({} as unknown as Env, USER, FILE, KEY)).toBeNull();
    expect(getThumbSecret({} as unknown as Env)).toBeNull();
  });
});
