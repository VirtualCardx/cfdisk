export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export function success<T>(data: T, status = 200): Response {
  const body: ApiResponse<T> = { success: true, data };
  return Response.json(body, { status });
}

export function error(code: string, message: string, status = 400): Response {
  const body: ApiResponse = { success: false, error: { code, message } };
  return Response.json(body, { status });
}

export const errors = {
  badRequest: (message = 'Bad request') => error('BAD_REQUEST', message, 400),
  unauthorized: (message = 'Unauthorized') => error('UNAUTHORIZED', message, 401),
  forbidden: (message = 'Forbidden') => error('FORBIDDEN', message, 403),
  notFound: (message = 'Not found') => error('NOT_FOUND', message, 404),
  conflict: (message = 'Conflict') => error('CONFLICT', message, 409),
  serverError: (message = 'Internal server error') => error('SERVER_ERROR', message, 500),
  quotaExceeded: (message = 'Storage quota exceeded') => error('QUOTA_EXCEEDED', message, 413),
  invalidInviteCode: () => error('INVALID_INVITE_CODE', 'Invalid or expired invite code', 400),
  invalidCredentials: () => error('INVALID_CREDENTIALS', 'Invalid username or password', 401),
  userDisabled: () => error('USER_DISABLED', 'User account is disabled', 403),
  shareExpired: () => error('SHARE_EXPIRED', 'This share link has expired', 410),
  sharePasswordRequired: () => error('SHARE_PASSWORD_REQUIRED', 'Password required', 401),
  refererNotAllowed: () => error('REFERER_NOT_ALLOWED', 'Access denied', 403),
};
