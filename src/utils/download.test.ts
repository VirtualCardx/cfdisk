import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { filenameFromDisposition, fetchDownload } from './download';

describe('filenameFromDisposition', () => {
  it('优先解析 RFC 5987 的 filename*', () => {
    const header = `attachment; filename="fallback.png"; filename*=UTF-8''%E4%B8%AD%E6%96%87.png`;
    expect(filenameFromDisposition(header, 'x')).toBe('中文.png');
  });

  it('解析普通 filename，带引号和不带引号都支持', () => {
    expect(filenameFromDisposition('attachment; filename="a b.png"', 'x')).toBe('a b.png');
    expect(filenameFromDisposition('attachment; filename=report.pdf', 'x')).toBe('report.pdf');
  });

  it('没有头或格式不对时回退', () => {
    expect(filenameFromDisposition(null, 'fallback.bin')).toBe('fallback.bin');
    expect(filenameFromDisposition('attachment', 'fallback.bin')).toBe('fallback.bin');
    expect(filenameFromDisposition('attachment; filename=', 'fallback.bin')).toBe('fallback.bin');
  });

  it('filename* 解码失败时回退，不抛错', () => {
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''%E4%B8`, 'fallback.bin')).toBe(
      'fallback.bin'
    );
  });
});

/** 造一个按字节区间切片的假响应，模拟服务端的 206 分支 */
function rangeResponse(body: Uint8Array, start: number, end: number): Response {
  const slice = body.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(slice.byteLength),
    },
  });
}

describe('fetchDownload', () => {
  const MB = 1024 * 1024;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('小文件走单流，不做 Range 请求', async () => {
    const body = new Uint8Array(1024).fill(7);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(body, { headers: { 'Content-Length': String(body.byteLength) } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const blob = await fetchDownload('/api/files/x/download', { expectedSize: 1024 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.Range).toBeUndefined();
    expect(blob.size).toBe(1024);
  });

  it('大文件按 4 段并发取回并按顺序拼接', async () => {
    const total = 20 * MB;
    const body = new Uint8Array(total);
    // 用位置相关的值，拼接顺序错了就能看出来
    for (let i = 0; i < total; i++) body[i] = i % 251;

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const header = (init?.headers as Record<string, string>)?.Range ?? '';
      const match = /^bytes=(\d+)-(\d+)$/.exec(header);
      if (!match) throw new Error(`unexpected range: ${header}`);
      return rangeResponse(body, Number(match[1]), Number(match[2]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const progress: number[] = [];
    const blob = await fetchDownload('/api/files/x/download', {
      expectedSize: total,
      onProgress: (p) => progress.push(p.percent ?? -1),
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(blob.size).toBe(total);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes[0]).toBe(0);
    expect(bytes[total - 1]).toBe((total - 1) % 251);
    expect(bytes[10 * MB]).toBe((10 * MB) % 251);

    // 进度必须单调不减，最后到 100
    const monotonic = progress.every((value, index) => index === 0 || value >= progress[index - 1]!);
    expect(monotonic).toBe(true);
    expect(progress[progress.length - 1]).toBe(100);
  });

  it('服务端不认 Range（返回 200 全量）时回退单流，不产生残缺文件', async () => {
    const total = 18 * MB;
    const body = new Uint8Array(total).fill(3);
    let rangeAttempts = 0;

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const header = (init?.headers as Record<string, string>)?.Range;
      if (header) {
        rangeAttempts += 1;
        // 忽略 Range，直接给全量 200
        return new Response(body.slice(), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      return new Response(body.slice(), {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(total),
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const blob = await fetchDownload('/api/files/x/download', { expectedSize: total });

    expect(rangeAttempts).toBeGreaterThan(0);
    expect(blob.size).toBe(total);
    // 回退后必须恰好再发一次不带 Range 的请求
    const fullRequests = fetchMock.mock.calls.filter(
      (call) => !((call[1] as RequestInit | undefined)?.headers as Record<string, string>)?.Range
    );
    expect(fullRequests).toHaveLength(1);
  });

  it('HTTP 错误透出服务端文案', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'File not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(fetchDownload('/api/files/x/download')).rejects.toThrow('File not found');
  });
});
