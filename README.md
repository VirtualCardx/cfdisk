# cfdisk

部署在 Cloudflare 上的轻量网盘：单 Worker 同时提供 API 与前端静态资源，数据存 D1，文件存 R2。

## 功能

- 邀请码注册、登录、修改密码（JWT + PBKDF2-SHA256）
- 登录态 30 天有效，并在剩余 7 天时静默续期（只要还在用就不会掉线）
- 会话可吊销：登出即刻失效当前设备，改密码 / 改角色踢掉其他所有设备
- 文件与文件夹管理：新建、重命名、移动、面包屑导航、软删除
- 多选批量操作：全选、批量移动（文件夹选择器）、批量删除
- 按名称搜索，结果显示所在路径
- 上传：≤5MB 直传，>5MB 自动按 5MB 分片上传，中间分片 3 路并发，单片失败重试 3 次
- 批量上传进度：面板顶部显示 `12 total · 5 uploaded · 6 remaining`（失败时追加 `· 1 failed`）与队列整体进度条
- 下载：卡片底部显示实时进度与百分比，完成后短暂显示 Downloaded；大文件不再“点了没反应”
- 在线预览：图片、视频（Range 支持拖动进度）、音频、PDF、文本（可直接编辑保存）
- 分享：密码保护、有效期、防盗链、下载次数上限
- 回收站：整棵子树恢复 / 永久删除 / 清空，配额精确回收
- 管理后台：用户列表、配额调整、禁用、角色切换、邀请码、统计

## 技术栈

| 层 | 实现 |
|---|---|
| 前端 | Vue 3 + Pinia + vue-router 5，Vite 7 构建 |
| 后端 | 单 Worker（`server/index.ts`），手写正则路由表 |
| 数据库 | Cloudflare D1（SQLite），迁移文件在 `migrations/` |
| 对象存储 | Cloudflare R2，对象键为 `${userId}/${fileId}` |
| 鉴权 | 自实现 HS256 JWT（`crypto.subtle`）+ PBKDF2 10 万次迭代 |

## 目录结构

```
server/
  index.ts              入口：路由表、CORS、静态资源兜底
  routes/               auth / files / folders / share / trash / admin / init
  middleware/auth.ts    Bearer token 校验，注入 auth.user
  utils/                jwt、hash、quota、range、http、trash、ratelimit、session、validate
  db/schema.sql         最新结构快照（仅供参考，实际用 migrations）
migrations/             D1 迁移（0001 初始结构、0002 回收站批次、0003 限流、0004 token 吊销）
.github/workflows/      CI：类型检查 + 单元测试 + 构建
src/
  views/                Init / Login / Register / Drive / Trash / Shares / Admin / SharedFile
  components/preview/   PreviewModal 预览与文本编辑
  stores/               auth、files、upload、ui
  utils/uploadChunked.ts 分片上传实现
```

## 本地开发

```bash
npm install

# 本地密钥（不要提交）
echo 'JWT_SECRET=dev-only-change-me' > .dev.vars

# 建本地 D1 表结构
npx wrangler d1 migrations apply cfdisk-db --local

npm run dev          # http://localhost:5173
npm run type-check   # vue-tsc
npm test             # vitest 单元测试（jwt / range / http / validate / quota）
npm run build        # 类型检查 + 构建
npm run preview      # 构建后用 wrangler 跑真实产物（http://localhost:8787）
```

`npm run preview` 会读取 `dist/cfdisk/wrangler.json`（Vite 插件生成的部署配置），
这样静态资源、SPA 兜底和 Worker 的行为与线上一致；直接 `wrangler dev` 不会挂载构建产物。

首次访问会跳转 `/init` 创建管理员，并自动下发 5 个邀请码。

本地数据保存在 `.wrangler/state`，删掉该目录即可重置。

## 部署到 Cloudflare

前置：已登录 `npx wrangler login`。

**1. 创建资源**

```bash
npx wrangler d1 create cfdisk-db
npx wrangler r2 bucket create cfdisk-storage
```

把 `d1 create` 返回的 `database_id` 写入 `wrangler.jsonc` 的 `d1_databases[0].database_id`。

**2. 写入 JWT 密钥**

```bash
# 生成一个 32 字节随机串
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npx wrangler secret put JWT_SECRET
```

**3. 初始化线上表结构**

```bash
npx wrangler d1 migrations apply cfdisk-db --remote
```

**4. 构建并发布**

```bash
npm run deploy       # = npm run build && wrangler deploy
```

发布后访问 Worker 域名进入 `/init` 创建管理员。

**5. 升级已有实例**

```bash
git pull
npx wrangler d1 migrations apply cfdisk-db --remote
npm run deploy
```

迁移是追加式的：`0002` 为存量数据回填 `deletion_batch_id`，`0003` 创建限流表，`0004` 增加 token 版本号与吊销黑名单。执行前建议先备份：

```bash
npx wrangler d1 export cfdisk-db --remote --output backup.sql
```

## 配置项

| 名称 | 位置 | 说明 |
|---|---|---|
| `JWT_SECRET` | `wrangler secret put` / 本地 `.dev.vars` | 必填，缺失时登录返回 500 |
| `ALLOWED_ORIGINS` | `wrangler secret put` 或 `vars` | 可选，跨域白名单，逗号分隔。同源请求始终放行；不配置则不返回任何 CORS 头 |
| `DB` | `wrangler.jsonc` | D1 绑定，变量名固定为 `DB` |
| `R2` | `wrangler.jsonc` | R2 绑定，变量名固定为 `R2` |
| `ASSETS` | `wrangler.jsonc` | 静态资源绑定。Worker 用它在前端路由未命中文件时返回 `index.html`，缺了它刷新 `/drive` 会 404 |

## 数据模型要点

- `files` 表同时存文件和文件夹，`type` 区分；文件夹的 `size` 不计入配额
- 软删除写入 `deleted_at`、`original_parent_id`（原父目录）和 `deletion_batch_id`（本次删除批次）
- 回收站按 `original_parent_id` 结构重建父子关系，不依赖时间戳相等
- 恢复只恢复同批次节点；永久删除按结构删除整棵子树，避免父目录消失后留下孤儿记录
- 配额变更全部走条件 `UPDATE`（`utils/quota.ts`），避免并发上传超卖

## API 速览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/init` | 检查 / 创建管理员 |
| POST | `/api/auth/register`、`/login`、`/logout` | 邀请码注册、登录、登出 |
| POST | `/api/auth/refresh` | 用仍有效的 token 换一张新的 30 天 token（滑动续期） |
| GET | `/api/auth/me` | 当前用户与配额 |
| GET | `/api/files?parent_id=` | 列表 + 面包屑 |
| GET | `/api/files/search?q=` | 按名称搜索，返回所在路径，最多 50 条 |
| POST | `/api/files/upload` | 直传（multipart/form-data） |
| POST | `/api/files/upload-chunk` | 分片上传 |
| GET | `/api/files/:id/download` | 下载 |
| GET | `/api/files/:id/preview-token` | 签发 1 小时预览地址 |
| GET | `/api/files/:id/preview?t=` | 预览（支持 Range） |
| GET/PUT | `/api/files/:id/content` | 读取 / 保存文本内容 |
| PUT | `/api/files/move` | 批量移动（拒绝移入自身后代） |
| GET | `/api/trash` | 回收站根节点列表 |
| POST | `/api/trash/:id/restore` | 恢复子树 |
| DELETE | `/api/trash/:id` | 永久删除子树 |
| DELETE | `/api/trash` | 清空回收站 |
| POST/GET | `/api/share` | 创建 / 列出分享 |
| GET | `/api/s/:token` | 公开访问分享 |
| POST | `/api/s/:token/verify` | 校验密码，签发短期访问凭证 |
| GET | `/api/s/:token/download?access=` | 下载（凭证校验） |
| GET | `/api/admin/*` | 用户、配额、邀请码、统计 |

## 安全机制

- **CORS**：同源放行；跨域必须显式配置 `ALLOWED_ORIGINS`，未命中不返回任何 CORS 头
- **限流**（D1 固定窗口计数，超限返回 429 + `Retry-After`）：

| 接口 | 维度 | 阈值 |
|---|---|---|
| `POST /api/auth/login` | IP | 10 次 / 5 分钟 |
| `POST /api/auth/register` | IP | 5 次 / 小时 |
| `PUT /api/auth/password` | 用户 | 10 次 / 小时 |
| `POST /api/auth/refresh` | 用户 | 30 次 / 小时 |
| `POST /api/s/:token/verify` | IP + 分享 | 10 次 / 10 分钟 |
| `POST /api/init` | IP | 5 次 / 小时 |

- **分享**：密码校验通过后签发 1 小时 `role=share` 凭证，下载/预览必须携带 `?access=`
- **会话吊销**：
  - JWT 携带 `tv`（用户 token 版本号），与 `users.token_version` 不一致即返回 401 `TOKEN_REVOKED`
  - 改密码、改角色、禁用账号都会把版本号 +1，此前签发的所有 token 立即失效
  - 登出把当前 token 的 `jti` 写入 `revoked_tokens`，只影响当前设备；其他设备继续可用
  - 版本校验与用户查询合并成一条 SQL，不额外增加数据库往返
  - 改密码后服务端给当前设备补发 token，用户无需重新登录
  - 登录态 30 天，前端在剩余不足 7 天时调 `/api/auth/refresh` 静默续期；续期同样走 `authenticate`，改密码 / 登出后的旧 token 无法续命
- **上传**：文件类型决定 `Content-Type`，SVG/HTML 等主动内容强制 `attachment`，预览统一 `nosniff`

## 已知限制

- 单次请求体上限 100MB（Cloudflare 限制），更大的文件走分片上传
- 直传走 Worker 内存，超大文件请优先用分片路径
- 分片上传状态存在 R2 的 `upload-state/` 前缀下，中断的上传会残留；建议给该前缀加一条 R2 生命周期规则（如 1 天过期）
- 吊销状态存在 D1，每次鉴权依赖一次数据库查询（已与用户查询合并为一条 SQL），无额外缓存层
- 单元测试覆盖纯函数逻辑；路由与 D1 交互目前靠本地 dev + curl 手工验证，未接入 `@cloudflare/vitest-pool-workers`
- 限流基于 D1，单个 Worker 实例外仍有一致性延迟，极端并发下可能放过少量请求
