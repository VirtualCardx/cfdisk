/**
 * HTTP 响应头工具
 */

/** RFC 5987 编码（用于 filename*） */
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%(7C|60|5E)/g, (str) => str.toUpperCase());
}

/** ASCII 回退名：非 ASCII 字符替换为下划线 */
function asciiFallback(value: string): string {
  const fallback = value.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return fallback || 'download';
}

/**
 * 构造同时兼容新旧浏览器的 Content-Disposition。
 * 中文文件名必须走 filename*，否则浏览器会显示成 %E4%B8%AD 这类编码串。
 */
export function contentDisposition(filename: string, type: 'inline' | 'attachment' = 'attachment'): string {
  const fallback = asciiFallback(filename);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(filename)}`;
}

/**
 * 文本类内容补上 charset，否则浏览器会用 latin-1 解码导致中文乱码。
 */
export function withCharset(mimeType: string | null | undefined): string {
  const mime = mimeType || 'application/octet-stream';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return `${mime}; charset=utf-8`;
  }
  return mime;
}

/**
 * 可主动执行脚本的类型。同源内联渲染会造成存储型 XSS（可窃取 localStorage 中的 token），
 * 因此这类文件只能下载，不能内联展示。
 */
export function isActiveContent(mimeType: string | null | undefined): boolean {
  const mime = (mimeType || '').toLowerCase();
  return (
    mime === 'image/svg+xml' ||
    mime === 'text/html' ||
    mime === 'application/xhtml+xml' ||
    mime === 'application/xml' ||
    mime === 'text/xml'
  );
}
