import { errors } from './utils/response';
import { handleRegister, handleLogin, handleLogout, handleGetMe, handleChangePassword } from './routes/auth';
import {
  handleListFiles,
  handleGetUploadUrl,
  handleConfirmUpload,
  handleDirectUpload,
  handleDownload,
  handleRename,
  handleDelete,
  handleMove,
  handleGetContent,
  handleSaveContent,
  handlePreview,
} from './routes/files';
import { handleCreateFolder, handleRenameFolder, handleDeleteFolder, handleGetFolder } from './routes/folders';
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
  { method: 'PUT', pattern: /^\/api\/auth\/password$/, handler: handleChangePassword },

  // File routes
  { method: 'GET', pattern: /^\/api\/files$/, handler: handleListFiles },
  { method: 'POST', pattern: /^\/api\/files\/upload-url$/, handler: handleGetUploadUrl },
  { method: 'POST', pattern: /^\/api\/files\/confirm$/, handler: handleConfirmUpload },
  { method: 'POST', pattern: /^\/api\/files\/upload$/, handler: handleDirectUpload },
  { method: 'PUT', pattern: /^\/api\/files\/move$/, handler: handleMove },
  { method: 'GET', pattern: /^\/api\/files\/([^/]+)\/download$/, handler: handleDownload, paramIndex: 1 },
  { method: 'GET', pattern: /^\/api\/files\/([^/]+)\/preview$/, handler: handlePreview, paramIndex: 1 },
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

function addCorsHeaders(response: Response, request: Request): Response {
  const origin = request.headers.get('Origin');
  const headers = new Headers(response.headers);
  
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function handleOptions(request: Request): Response {
  const headers = new Headers();
  const origin = request.headers.get('Origin');
  
  if (origin) {
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
      return handleOptions(request);
    }

    // Only handle /api/* routes
    if (!path.startsWith('/api/')) {
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
        return addCorsHeaders(response, request);
      } catch (e) {
        console.error('Route handler error:', e);
        return addCorsHeaders(errors.serverError('Internal server error'), request);
      }
    }

    return addCorsHeaders(errors.notFound('API endpoint not found'), request);
  },
} satisfies ExportedHandler<Env>;
