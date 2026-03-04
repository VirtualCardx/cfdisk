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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: { skipAuth?: boolean; headers?: Record<string, string> } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    ...options.headers,
  };

  if (!options.skipAuth) {
    const token = getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
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

  if (response.status === 401) {
    setToken(null);
    window.location.href = '/login';
    throw new ApiError('UNAUTHORIZED', 'Session expired', 401);
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
