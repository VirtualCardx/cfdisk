/**
 * 带进度的下载。
 *
 * 网盘里的文件动辄几十上百 MB，直接 `a[href]` 或 `response.blob()` 期间
 * 界面完全没有反馈，用户会以为按钮没生效。这里用流式读取边下边报进度。
 *
 * 大文件（≥ PARALLEL_THRESHOLD）默认走多段并发 Range：跨境/高延迟链路上
 * 单条 TCP 连接很难把带宽喂满，4 条并行连接通常能显著缩短总时长。
 */
export interface DownloadProgress {
  received: number;
  /** 服务端未返回 Content-Length 时为 null，进度不可知 */
  total: number | null;
  /** 0-100；未知总大小时为 null，调用方应展示不确定态 */
  percent: number | null;
}

export interface DownloadOptions {
  headers?: Record<string, string>;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** 已知的文件总大小（字节）。传了才会对大文件启用多段并行下载 */
  expectedSize?: number;
}

/** 大于这个大小才值得开多连接 */
const PARALLEL_THRESHOLD = 16 * 1024 * 1024;
/** 并行连接数：浏览器同域上限 6，留两条给页面其它请求 */
const PARALLEL_CONNECTIONS = 4;
/** 每段至少 4MB，太小的文件切段反而增加固定开销 */
const MIN_CHUNK_BYTES = 4 * 1024 * 1024;

/** 把 Blob 交给浏览器下载；延迟 revoke，避免部分浏览器中断保存 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 服务端不认 Range（返回 200 或长度不符）时用它回退到单流下载 */
class RangeUnsupportedError extends Error {
  constructor() {
    super('Range not supported');
    this.name = 'RangeUnsupportedError';
  }
}

/** 流式读完响应体，按块回调字节数；返回拼好的 Blob */
async function readBody(response: Response, onBytes: (bytes: number) => void): Promise<Blob> {
  const type = response.headers.get('Content-Type') || 'application/octet-stream';

  if (!response.body) {
    // 极端情况下没有流（老浏览器），退化成一次性读取
    const blob = await response.blob();
    onBytes(blob.size);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value as BlobPart);
      onBytes(value.byteLength);
    }
  }
  return new Blob(chunks, { type });
}

async function fetchOrThrow(
  url: string,
  options: DownloadOptions,
  headers?: Record<string, string>
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { ...options.headers, ...headers },
      signal: options.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new Error('Network error, please retry');
  }

  if (!response.ok) {
    // 尽量把服务端的错误文案透出来（配额、文件不存在等）
    const message = await response
      .clone()
      .json()
      .then((json: { error?: { message?: string } }) => json.error?.message)
      .catch(() => null);
    throw new Error(message || `Download failed (${response.status})`);
  }

  return response;
}

/** 多段并发拉取，任意一段不满足预期就整体回退 */
async function fetchInRanges(
  url: string,
  total: number,
  options: DownloadOptions,
  onBytes: (bytes: number) => void
): Promise<Blob> {
  const connections = Math.max(
    1,
    Math.min(PARALLEL_CONNECTIONS, Math.floor(total / MIN_CHUNK_BYTES))
  );
  const chunkSize = Math.ceil(total / connections);
  const parts: (Blob | undefined)[] = new Array(connections);
  let contentType = 'application/octet-stream';

  await Promise.all(
    Array.from({ length: connections }, async (_, index) => {
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, total) - 1;
      const expected = end - start + 1;

      const response = await fetchOrThrow(url, options, {
        Range: `bytes=${start}-${end}`,
      });

      if (response.status !== 206) throw new RangeUnsupportedError();
      if (index === 0) {
        contentType = response.headers.get('Content-Type') || contentType;
      }

      const blob = await readBody(response, onBytes);
      if (blob.size !== expected) throw new RangeUnsupportedError();
      parts[index] = blob;
    })
  );

  // 关闭时理论上不会缺段；保险再判一次，避免拼出残缺文件
  const assembled = parts.filter((part): part is Blob => part !== undefined);
  if (assembled.length !== connections) throw new RangeUnsupportedError();

  return new Blob(assembled, { type: contentType });
}

/**
 * 把文件拉成 Blob（不落盘）。
 *
 * 大文件优先多段并行；服务端不支持 Range 时静默回退单流，保证行为不退化。
 * 拆出来是为了让调用方和测试都能绕开 DOM。
 */
export async function fetchDownload(
  url: string,
  options: DownloadOptions = {}
): Promise<Blob> {
  const knownTotal =
    typeof options.expectedSize === 'number' && options.expectedSize > 0
      ? options.expectedSize
      : null;

  if (knownTotal !== null && knownTotal >= PARALLEL_THRESHOLD) {
    let received = 0;
    try {
      return await fetchInRanges(url, knownTotal, options, (bytes) => {
        received += bytes;
        options.onProgress?.({
          received,
          total: knownTotal,
          percent: Math.min(100, Math.round((received / knownTotal) * 100)),
        });
      });
    } catch (e) {
      if (!(e instanceof RangeUnsupportedError)) throw e;
      // 回退：清掉已知总量，交给下面的单流分支按真实响应重新计数
    }
  }

  const response = await fetchOrThrow(url, options);
  const lengthHeader = response.headers.get('Content-Length');
  const total = lengthHeader ? Number(lengthHeader) || null : knownTotal;

  let received = 0;
  return readBody(response, (bytes) => {
    received += bytes;
    options.onProgress?.({
      received,
      total,
      percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
    });
  });
}

export async function downloadWithProgress(
  url: string,
  filename: string,
  options: DownloadOptions = {}
): Promise<void> {
  const onProgress = options.onProgress;
  let lastEmit = 0;

  // 进度回调最多每 80ms 触发一次，避免大文件把主线程刷爆
  const report = (progress: DownloadProgress, force = false): void => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    onProgress(progress);
  };

  const blob = await fetchDownload(url, {
    ...options,
    onProgress: (progress) => report(progress),
  });

  report({ received: blob.size, total: blob.size, percent: 100 }, true);

  saveBlob(blob, filename);
}

const PROGRESS_INTERVAL_MS = 80;

/** 从 Content-Disposition 里取文件名，取不到时用回退值 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      return fallback;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? fallback;
}
