import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt, extractToken, TOKEN_TTL_SECONDS } from './jwt';

const SECRET = 'test-secret-value';

function base64Url(input: object): string {
  return btoa(JSON.stringify(input)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('signJwt / verifyJwt', () => {
  it('默认有效期是 30 天', async () => {
    const token = await signJwt({ sub: 'user-1', role: 'admin', tv: 3 }, SECRET);
    const payload = await verifyJwt(token, SECRET);

    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('user-1');
    expect(payload!.role).toBe('admin');
    expect(payload!.tv).toBe(3);
    expect(payload!.jti).toBeTruthy();
    expect(payload!.exp - payload!.iat).toBe(TOKEN_TTL_SECONDS);
    expect(TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it('自定义有效期生效', async () => {
    const token = await signJwt({ sub: 'u', role: 'share' }, SECRET, 300);
    const payload = await verifyJwt(token, SECRET);
    expect(payload!.exp - payload!.iat).toBe(300);
  });

  it('每次签发的 jti 都不同', async () => {
    const a = await verifyJwt(await signJwt({ sub: 'u', role: 'user' }, SECRET), SECRET);
    const b = await verifyJwt(await signJwt({ sub: 'u', role: 'user' }, SECRET), SECRET);
    expect(a!.jti).not.toBe(b!.jti);
  });

  it('换密钥后验签失败', async () => {
    const token = await signJwt({ sub: 'u', role: 'user' }, SECRET);
    expect(await verifyJwt(token, 'another-secret')).toBeNull();
  });

  it('篡改 payload 后验签失败', async () => {
    const token = await signJwt({ sub: 'user-1', role: 'user' }, SECRET);
    const [header, , signature] = token.split('.');
    const forged = `${header}.${base64Url({ sub: 'user-1', role: 'admin', jti: 'x', iat: 1, exp: 9999999999 })}.${signature}`;
    expect(await verifyJwt(forged, SECRET)).toBeNull();
  });

  it('过期 token 验签失败', async () => {
    const token = await signJwt({ sub: 'u', role: 'user' }, SECRET, -10);
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });

  it('结构不合法时返回 null 而不抛错', async () => {
    expect(await verifyJwt('not-a-token', SECRET)).toBeNull();
    expect(await verifyJwt('a.b', SECRET)).toBeNull();
    expect(await verifyJwt('a.b.c', SECRET)).toBeNull();
  });
});

describe('extractToken', () => {
  it('取 Bearer 前缀后的内容', () => {
    const request = new Request('https://example.com/api/files', {
      headers: { Authorization: 'Bearer abc.def.ghi' },
    });
    expect(extractToken(request)).toBe('abc.def.ghi');
  });

  it('缺少或格式不符时返回 null', () => {
    expect(extractToken(new Request('https://example.com/'))).toBeNull();
    expect(
      extractToken(new Request('https://example.com/', { headers: { Authorization: 'Basic abc' } }))
    ).toBeNull();
  });
});
