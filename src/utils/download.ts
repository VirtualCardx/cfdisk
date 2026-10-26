/**
 * 带进度的下载。
 *
 * 网盘里的文件动辄几十上百 MB，直接 `a[href]` 或 `response.blob()` 期间
 * 界面完全没有反馈，用户会以为按钮没生效。这里用流式读取边下边报进度。
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
}

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

/** 进度回调最多每 80ms 触发一次，避免大文件把主线程刷爆 */
const PROGRESS_INTERVAL_MS = 80;

export async function downloadWithProgress(
  url: string,
  filename: string,
  options: DownloadOptions = {}
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { headers: options.headers, signal: options.signal });
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

  const lengthHeader = response.headers.get('Content-Length');
  const total = lengthHeader ? Number(lengthHeader) || null : null;

  let received = 0;
  let lastEmit = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    options.onProgress?.({
      received,
      total,
      percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
    });
  };

  let blob: Blob;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];
    emit(true);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value as BlobPart);
        received += value.byteLength;
        emit();
      }
    }
    blob = new Blob(chunks, {
      type: response.headers.get('Content-Type') || 'application/octet-stream',
    });
  } else {
    // 极端情况下没有流（老浏览器），退化成一次性读取
    blob = await response.blob();
    received = blob.size;
  }

  options.onProgress?.({
    received: blob.size,
    total: total ?? blob.size,
    percent: 100,
  });

  saveBlob(blob, filename);
}

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
