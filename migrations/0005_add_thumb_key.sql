-- 缩略图对象键。
-- 上传时由前端生成的 320px WebP 存到 R2，列表页只取这个几十 KB 的小图，
-- 避免为了渲染 96px 的格子而下载 10MB 原图。
ALTER TABLE files ADD COLUMN thumb_r2_key TEXT;
