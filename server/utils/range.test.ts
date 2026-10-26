import { describe, it, expect } from 'vitest';
import { parseRange } from './range';

const SIZE = 1000;

describe('parseRange', () => {
  it('无 Range 头时返回 null', () => {
    expect(parseRange(null, SIZE)).toBeNull();
    expect(parseRange('', SIZE)).toBeNull();
  });

  it('普通区间', () => {
    expect(parseRange('bytes=0-99', SIZE)).toEqual({ offset: 0, length: 100, start: 0, end: 99 });
    expect(parseRange('bytes=500-599', SIZE)).toEqual({
      offset: 500,
      length: 100,
      start: 500,
      end: 599,
    });
  });

  it('开放结尾取到文件末尾', () => {
    expect(parseRange('bytes=900-', SIZE)).toEqual({ offset: 900, length: 100, start: 900, end: 999 });
  });

  it('后缀形式取最后 N 字节', () => {
    expect(parseRange('bytes=-100', SIZE)).toEqual({ offset: 900, length: 100, start: 900, end: 999 });
    // 后缀长度超过文件大小时从头开始
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ offset: 0, length: 1000, start: 0, end: 999 });
  });

  it('结束位置越界时截断到末尾', () => {
    expect(parseRange('bytes=900-99999', SIZE)).toEqual({
      offset: 900,
      length: 100,
      start: 900,
      end: 999,
    });
  });

  it('起点越界、区间倒置一律降级', () => {
    expect(parseRange('bytes=1000-', SIZE)).toBeNull();
    expect(parseRange('bytes=999-1', SIZE)).toBeNull();
  });

  it('多段 Range 降级为完整响应', () => {
    expect(parseRange('bytes=0-99,200-299', SIZE)).toBeNull();
  });

  it('非法单位与格式返回 null', () => {
    expect(parseRange('items=0-9', SIZE)).toBeNull();
    expect(parseRange('bytes=-', SIZE)).toBeNull();
    expect(parseRange('bytes=abc-def', SIZE)).toBeNull();
    expect(parseRange('bytes=-0', SIZE)).toBeNull();
  });

  it('空文件不做区间处理', () => {
    expect(parseRange('bytes=0-0', 0)).toBeNull();
  });

  it('单字节区间', () => {
    expect(parseRange('bytes=5-5', SIZE)).toEqual({ offset: 5, length: 1, start: 5, end: 5 });
  });
});
