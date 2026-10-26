import { errors } from './utils/response';
import { handleRegister, handleLogin, handleLogout, handleGetMe, handleRefresh, handleChangePassword } from './routes/auth';
import {
  handleListFiles,
  handleDirectUpload,
  handleUploadChunk,
  handleDownload,
  handleRename,
  handleDelete,
  handleMove,
  handleGetContent,
  handleSaveContent,
  handlePreview,
  handleGetPreviewToken,
  handleSearchFiles,
} from './routes/files';
import { handleCreateFolder, handleRenameFolder, handleDeleteFolder, handleGetFolder } from './routes/folders';
import { handleGetThumb, handleUploadThumb } from './routes/thumb';
import { handleListTrash, handleRestoreFile, handlePermanentDelete, handleEmptyTrash } from './routes/trash';
import {
  handleCreateShare,
  handleListShares,
  handleDeleteShare,
  handleAccessShare,
  handleVerifySharePassword,
  handleShareDownload,
  handleSharePreview,
} from './routes/share';
import {
  handleListUsers,
  handleSetUserQuota,
  handleSetUserStatus,
  handleSetUserRole,
  handleCreateInviteCode,
  handleListInviteCodes,
  handleDeleteInviteCode,
  handleGetStats,
} from './routes/admin';
import { handleInit, handleCheckInit } from './routes/init';

type Handler = (request: Request, env: Env, param?: string) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  paramIndex?: number;
}

const routes: Route[] = [
  // Init routes (public, only works if no admin exists)
  { method: 'GET', pattern: /^\/api\/init$/, handler: handleCheckInit },
  { method: 'POST', pattern: /^\/api\/init$/, handler: handleInit },

  // Auth routes
  { method: 'POST', pattern: /^\/api\/auth\/register$/, handler: handleRegister },
  { method: 'POST', pattern: /^\/api\/auth\/login$/, handler: handleLogin },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, handler: handleLogout },
  { method: 'GET', pattern: /^\/api\/auth\/me$/, handler: handleGetMe },
  { method: 'POST', pattern: /^\/api\/auth\/refresh$/, handler: handleRefresh },
  { method: 'PUT', pattern: /^\/api\/auth\/password$/, handler: handleChangePassword },

  // File routes
  { method: 'GET', pattern: /^\/api\/files$/, handler: handleListFiles },
  { method: 'GET', pattern: /^\/api\/files\/search$/, handler: handleSearchFiles },
  { method: 'POST', pattern: /^\/api\/files\/upload$/, handler: handleDirectUpload },
  { method: 'POST', pattern: /^\/api\/files\/upload-chunk$/, handler: handleUploadChunk },
  { method: 'PUT', pattern: /^\/api\/files\/move$/, handler: handleMove },
  { method: 'GET', pattern: /^\/api\/files\/([^/]+)\/download$/, handler: handleDownload, paramIndex: 1 },
  { method: 'GET', pattern: /^\/api\/files\/([^/]+)\/preview$/, handler: handlePreview, paramIndex: 1 },
  { method: 'GET', pattern: /^\/api\/files\/([^/]+)\/preview-token$/, handler: handleGetPreviewToken, paramIndex: 1 },
  { method: 'GET', pattern: /^\/api\/files\/([^/]+)\/thumb$/, handler: handleGetThumb, paramIndex: 1 },
  { method: 'PUT', pattern: /^\/api\/files\/([^/]+)\/thumb$/, handler: handleUploadThumb, paramIndex: 1 },
  { method: 'GET', pattern: /^\/api\/files\/([^/]+)\/content$/, handler: handleGetContent, paramIndex: 1 },
  { method: 'PUT', pattern: /^\/api\/files\/([^/]+)\/content$/, handler: handleSaveContent, paramIndex: 1 },
  { method: 'PUT', pattern: /^\/api\/files\/([^/]+)\/rename$/, handler: handleRename, paramIndex: 1 },
  { method: 'DELETE', pattern: /^\/api\/files\/([^/]+)$/, handler: handleDelete, paramIndex: 1 },

  // Folder routes
  { method: 'POST', pattern: /^\/api\/folders$/, handler: handleCreateFolder },
  { method: 'GET', pattern: /^\/api\/folders\/([^/]+)$/, handler: handleGetFolder, paramIndex: 1 },
  { method: 'PUT', pattern: /^\/api\/folders\/([^/]+)\/rename$/, handler: handleRenameFolder, paramIndex: 1 },
  { method: 'DELETE', pattern: /^\/api\/folders\/([^/]+)$/, handler: handleDeleteFolder, paramIndex: 1 },

  // Trash routes
  { method: 'GET', pattern: /^\/api\/trash$/, handler: handleListTrash },
  { method: 'DELETE', pattern: /^\/api\/trash$/, handler: handleEmptyTrash },
  { method: 'POST', pattern: /^\/api\/trash\/([^/]+)\/restore$/, handler: handleRestoreFile, paramIndex: 1 },
  { method: 'DELETE', pattern: /^\/api\/trash\/([^/]+)$/, handler: handlePermanentDelete, paramIndex: 1 },

  // Share routes (authenticated)
  { method: 'POST', pattern: /^\/api\/share$/, handler: handleCreateShare },
  { method: 'GET', pattern: /^\/api\/share$/, handler: handleListShares },
  { method: 'DELETE', pattern: /^\/api\/share\/([^/]+)$/, handler: handleDeleteShare, paramIndex: 1 },

  // Public share routes
  { method: 'GET', pattern: /^\/api\/s\/([^/]+)$/, handler: handleAccessShare, paramIndex: 1 },
  { method: 'POST', pattern: /^\/api\/s\/([^/]+)\/verify$/, handler: handleVerifySharePassword, paramIndex: 1 },
  { method: 'GET', pattern: /^\/api\/s\/([^/]+)\/download$/, handler: handleShareDownload, paramIndex: 1 },
  { method: 'GET', pattern: /^\/api\/s\/([^/]+)\/preview$/, handler: handleSharePreview, paramIndex: 1 },

  // Admin routes
  { method: 'GET', pattern: /^\/api\/admin\/users$/, handler: handleListUsers },
  { method: 'PUT', pattern: /^\/api\/admin\/users\/([^/]+)\/quota$/, handler: handleSetUserQuota, paramIndex: 1 },
  { method: 'PUT', pattern: /^\/api\/admin\/users\/([^/]+)\/status$/, handler: handleSetUserStatus, paramIndex: 1 },
  { method: 'PUT', pattern: /^\/api\/admin\/users\/([^/]+)\/role$/, handler: handleSetUserRole, paramIndex: 1 },
  { method: 'POST', pattern: /^\/api\/admin\/invite-codes$/, handler: handleCreateInviteCode },
  { method: 'GET', pattern: /^\/api\/admin\/invite-codes$/, handler: handleListInviteCodes },
  { method: 'DELETE', pattern: /^\/api\/admin\/invite-codes\/([^/]+)$/, handler: handleDeleteInviteCode, paramIndex: 1 },
  { method: 'GET', pattern: /^\/api\/admin\/stats$/, handler: handleGetStats },
];

/**
 * CORS 只对白名单来源开放。
 * 默认同源放行（前端与 API 由同一个 Worker 提供，本来就不需要 CORS 头），
 * 跨域来源必须显式写进 ALLOWED_ORIGINS（逗号分隔）。
 */
function isAllowedOrigin(origin: string, request: Request, env: Env): boolean {
  if (origin === new URL(request.url).origin) return true;

  const configured = (env as unknown as { ALLOWED_ORIGINS?: string }).ALLOWED_ORIGINS;
  if (!configured) return false;

  return configured
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(origin);
}

function addCorsHeaders(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get('Origin');
  if (!origin || !isAllowedOrigin(origin, request, env)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Vary', 'Origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function handleOptions(request: Request, env: Env): Response {
  const headers = new Headers();
  headers.set('Vary', 'Origin');

  const origin = request.headers.get('Origin');
  if (origin && isAllowedOrigin(origin, request, env)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Access-Control-Max-Age', '86400');
  }

  return new Response(null, { status: 204, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return handleOptions(request, env);
    }

    // Only handle /api/* routes
    if (!path.startsWith('/api/')) {
      // 静态资源由 Cloudflare Assets 优先处理，正常情况下请求不会走到这里。
      // 兜底用于「直接刷新前端路由」：/drive、/login 这类路径在 assets 里没有对应文件，
      // 需要返回 index.html 交给前端路由，否则刷新就是 404。
      const assets = (env as unknown as { ASSETS?: { fetch: (req: Request) => Promise<Response> } })
        .ASSETS;
      if (
        assets &&
        method === 'GET' &&
        (request.headers.get('Accept') || '').includes('text/html')
      ) {
        const indexUrl = new URL('/', url);
        return assets.fetch(new Request(indexUrl.toString(), request));
      }

      return new Response(null, { status: 404 });
    }

    // Find matching route
    for (const route of routes) {
      if (route.method !== method) continue;

      const match = path.match(route.pattern);
      if (!match) continue;

      try {
        const param = route.paramIndex !== undefined ? match[route.paramIndex] : undefined;
        const response = await route.handler(request, env, param);
        return addCorsHeaders(response, request, env);
      } catch (e) {
        console.error('Route handler error:', e);
        return addCorsHeaders(errors.serverError('Internal server error'), request, env);
      }
    }

    return addCorsHeaders(errors.notFound('API endpoint not found'), request, env);
  },
} satisfies ExportedHandler<Env>;
