export interface JwtPayload {
  sub: string;
  role: string;
  /** 预览凭证绑定的文件 ID */
  fid?: string;
  /** 用户 token 版本号，与 users.token_version 不符即视为已吊销 */
  tv?: number;
  jti: string;
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();

/**
 * 登录态有效期：30 天。
 *
 * 配合前端的滑动续期（token 剩余不足 7 天时静默换新），
 * 只要用户不是连续一个月不打开，登录态就不会掉。
 * 改密码会抬高 token_version，此前签发的 token 立刻全部作废。
 */
export const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'jti'>,
  secret: string,
  expiresInSeconds = TOKEN_TTL_SECONDS
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + expiresInSeconds,
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(fullPayload)));
  const message = `${headerB64}.${payloadB64}`;

  const key = await getKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const signatureB64 = base64UrlEncode(signature);

  return `${message}.${signatureB64}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const message = `${headerB64}.${payloadB64}`;

    const key = await getKey(secret);
    const signature = base64UrlDecode(signatureB64);
    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(message));

    if (!valid) return null;

    const payload: JwtPayload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64))
    );

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}

export function extractToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}
