/**
 * 缩略图签名
 *
 * 缩略图必须能被 `<img src>` 直接加载，没法带 Authorization 头，
 * 因此用 HMAC 签名代替鉴权：签名里绑定 userId / fileId / 对象键版本。
 *
 * 关键点是「稳定」——不能用 JWT（signJwt 每次生成随机 jti，URL 每次都变，
 * 浏览器缓存永远命中不了）。这里签名只由内容决定，同一版本的缩略图
 * URL 恒定，配合长缓存可以做到「下载一次，之后全走本地缓存」。
 */

const encoder = new TextEncoder();

/**
 * 同一请求内会给整页文件签 URL，逐次 importKey 是纯浪费，
 * 按 secret 缓存 CryptoKey（Worker 实例存活期内有效）。
 */
let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  cachedKey = { secret, key };
  return key;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 版本号取 R2 对象键本身，重新生成缩略图时键变化 → 签名自动失效 */
export async function thumbSignature(
  secret: string,
  userId: string,
  fileId: string,
  version: string
): Promise<string> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`thumb:${userId}:${fileId}:${version}`)
  );
  return base64UrlEncode(new Uint8Array(mac)).slice(0, 32);
}

/** 定长比较，避免签名校验被时序侧信道利用 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 生成可直接放进 <img> 的地址；没有缩略图对象时返回 null */
export async function buildThumbUrl(
  env: Env,
  userId: string,
  fileId: string,
  thumbKey: string | null | undefined
): Promise<string | null> {
  if (!thumbKey) return null;

  const secret = getThumbSecret(env);
  if (!secret) return null;

  const sig = await thumbSignature(secret, userId, fileId, thumbKey);
  return `/api/files/${fileId}/thumb?s=${sig}`;
}

/**
 * 复用 JWT_SECRET。缩略图签名与登录凭据共享密钥本身没有风险：
 * 两者前缀不同（`thumb:` vs JWT 的 `header.payload`），不可能互相伪造。
 */
export function getThumbSecret(env: Env): string | null {
  const secret = (env as unknown as { JWT_SECRET?: string }).JWT_SECRET;
  return secret && secret.length > 0 ? secret : null;
}
