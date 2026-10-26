/**
 * Range 请求解析
 */

export interface ByteRange {
  offset: number;
  length: number;
  start: number;
  end: number;
}

/**
 * 解析单段 Range 头。返回 null 表示应按完整内容响应。
 * 支持 `bytes=0-99`、`bytes=100-`、`bytes=-500` 三种形式；
 * 多段 Range 与越界请求一律降级为完整响应。
 */
export function parseRange(header: string | null, size: number): ByteRange | null {
  if (!header || size <= 0) return null;
  if (header.includes(',')) return null;

  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, rawStart, rawEnd] = match;

  if (!rawStart && !rawEnd) return null;

  let start: number;
  let end: number;

  if (!rawStart) {
    // 后缀形式：最后 N 字节
    const suffix = parseInt(rawEnd, 10);
    if (isNaN(suffix) || suffix <= 0) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end = rawEnd ? parseInt(rawEnd, 10) : size - 1;
    if (isNaN(start) || isNaN(end)) return null;
    if (start >= size) return null;
    if (end >= size) end = size - 1;
    if (end < start) return null;
  }

  return { offset: start, length: end - start + 1, start, end };
}
