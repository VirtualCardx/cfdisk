const API_BASE = '/api';

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function getToken(): string | null {
  return localStorage.getItem('token');
}

export function setToken(token: string | null): void {
  if (token) {
    localStorage.setItem('token', token);
  } else {
    localStorage.removeItem('token');
  }
}

/** token 剩余不足 7 天时自动续期，服务端会重新签发 30 天有效期 */
const REFRESH_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;
/** 同一标签页 10 分钟内最多尝试一次，失败（断网等）也不会反复打接口 */
const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;

let refreshPromise: Promise<void> | null = null;
let lastRefreshAt = 0;

/** 读取 JWT 的 exp，不验签（只用于判断要不要续期，安全性由服务端保证） */
export function getTokenExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp : null;
  } catch {
    return null;
  }
}

/** 距离登录态失效还有多少秒，无法解析时返回 null */
export function getTokenRemainingSeconds(): number | null {
  const token = getToken();
  if (!token) return null;
  const exp = getTokenExpiry(token);
  if (!exp) return null;
  return exp - Math.floor(Date.now() / 1000);
}

/**
 * 滑动续期：只要用户还在用，登录态就一直往后延。
 *
 * 直接用 fetch 而不是 request()，避免续期请求自己再触发续期。
 */
export function ensureFreshToken(): Promise<void> {
  const token = getToken();
  if (!token) return Promise.resolve();

  const remaining = getTokenRemainingSeconds();
  if (remaining === null || remaining > REFRESH_THRESHOLD_SECONDS) return Promise.resolve();

  if (Date.now() - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return Promise.resolve();
  if (refreshPromise) return refreshPromise;

  lastRefreshAt = Date.now();
  refreshPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return;

      const json = (await response.json()) as ApiResponse<{ token: string }>;
      const next = json.data?.token;
      // 续期成功前用户可能已经登出，此时不要把旧会话写回去
      if (typeof next === 'string' && next && getToken() === token) {
        setToken(next);
      }
    } catch {
      // 网络问题就算了，下次请求再试
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: { skipAuth?: boolean; headers?: Record<string, string> } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    ...options.headers,
  };

  let hasAuth = false;
  if (!options.skipAuth) {
    const token = getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      hasAuth = true;
    }
  }

  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });

  // 仅当本次请求确实携带了登录凭证时才判定为会话过期，
  // 否则分享页等公开接口的 401 会把用户错误地踢到登录页
  if (response.status === 401 && hasAuth) {
    // 区分「自然过期」和「被服务端吊销」，登录页给出不同提示
    const code = await response
      .clone()
      .json()
      .then((json: ApiResponse) => json.error?.code)
      .catch(() => undefined);

    setToken(null);
    window.location.href = `/login?reason=${code === 'TOKEN_REVOKED' ? 'revoked' : 'expired'}`;
    throw new ApiError(code || 'UNAUTHORIZED', 'Session expired', 401);
  }

  // 登录态进入最后 7 天时静默续期；不等待结果，不影响当前请求
  if (hasAuth) {
    void ensureFreshToken();
  }

  const contentType = response.headers.get('Content-Type');
  if (contentType?.includes('application/json')) {
    const json = (await response.json()) as ApiResponse<T>;
    if (!json.success) {
      throw new ApiError(
        json.error?.code || 'UNKNOWN_ERROR',
        json.error?.message || 'Unknown error',
        response.status
      );
    }
    return json.data as T;
  }

  if (!response.ok) {
    throw new ApiError('REQUEST_FAILED', `Request failed: ${response.status}`, response.status);
  }

  return response as unknown as T;
}

export const api = {
  get: <T>(path: string, options?: { skipAuth?: boolean }) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: { skipAuth?: boolean }) => request<T>('POST', path, body, options),
  put: <T>(path: string, body?: unknown, options?: { skipAuth?: boolean }) => request<T>('PUT', path, body, options),
  delete: <T>(path: string, options?: { skipAuth?: boolean }) => request<T>('DELETE', path, undefined, options),
};

export { ApiError };
