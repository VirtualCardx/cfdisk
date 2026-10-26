import { describe, it, expect } from 'vitest';
import { filenameFromDisposition } from './download';

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
