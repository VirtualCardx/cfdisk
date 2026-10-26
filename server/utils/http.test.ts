import { describe, it, expect } from 'vitest';
import { contentDisposition, withCharset, isActiveContent } from './http';

describe('contentDisposition', () => {
  it('中文文件名同时给出 ASCII 回退与 filename*', () => {
    const header = contentDisposition('测试文档.txt');

    expect(header).toContain('attachment;');
    // 回退名只能是 ASCII，否则老浏览器头部会报错
    expect(header).toMatch(/filename="[^"]*\.txt"/);
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('测试文档.txt')}`);
  });

  it('中文回退名被替换为下划线', () => {
    const header = contentDisposition('中文.txt');
    expect(header).toContain('filename="__.txt"');
  });

  it('转义 RFC 5987 保留字符', () => {
    const header = contentDisposition("a'b(c)*d.txt");
    const star = header.split("filename*=UTF-8''")[1];
    expect(star).not.toContain("'");
    expect(star).not.toContain('(');
    expect(star).not.toContain(')');
    expect(star).not.toContain('*');
  });

  it('双引号与反斜杠不能破坏头部', () => {
    const header = contentDisposition('a"b\\c.txt');
    expect(header.split('filename="')[1].split('"')[0]).toBe('a_b_c.txt');
  });

  it('inline 类型', () => {
    expect(contentDisposition('a.png', 'inline').startsWith('inline;')).toBe(true);
  });

  it('空名字回退为 download', () => {
    expect(contentDisposition('')).toContain('filename="download"');
  });
});

describe('withCharset', () => {
  it('文本类型补 charset', () => {
    expect(withCharset('text/plain')).toBe('text/plain; charset=utf-8');
    expect(withCharset('text/markdown')).toBe('text/markdown; charset=utf-8');
    expect(withCharset('application/json')).toBe('application/json; charset=utf-8');
  });

  it('二进制类型保持原样', () => {
    expect(withCharset('image/png')).toBe('image/png');
    expect(withCharset('application/pdf')).toBe('application/pdf');
  });

  it('空值降级为 octet-stream', () => {
    expect(withCharset(null)).toBe('application/octet-stream');
    expect(withCharset('')).toBe('application/octet-stream');
  });
});

describe('isActiveContent', () => {
  it('可执行脚本的类型识别为活动内容', () => {
    expect(isActiveContent('image/svg+xml')).toBe(true);
    expect(isActiveContent('text/html')).toBe(true);
    expect(isActiveContent('application/xhtml+xml')).toBe(true);
    expect(isActiveContent('application/xml')).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(isActiveContent('TEXT/HTML')).toBe(true);
  });

  it('普通图片与文档不是活动内容', () => {
    expect(isActiveContent('image/png')).toBe(false);
    expect(isActiveContent('text/plain')).toBe(false);
    expect(isActiveContent(null)).toBe(false);
  });
});
