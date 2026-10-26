import { describe, it, expect } from 'vitest';
import {
  isValidEmail,
  isValidUsername,
  isValidPassword,
  isValidFileName,
  sanitizeFileName,
  isValidUUID,
  getMimeType,
  isTextFile,
  generateInviteCode,
  generateShareToken,
  formatBytes,
} from './validate';

describe('isValidEmail', () => {
  it('接受常见格式', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('first.last+tag@example.com')).toBe(true);
  });

  it('拒绝缺少 @ 或域名的输入', () => {
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('ab.com')).toBe(false);
    expect(isValidEmail('a b@c.com')).toBe(false);
  });
});

describe('isValidUsername', () => {
  it('3-32 位字母数字下划线', () => {
    expect(isValidUsername('abc')).toBe(true);
    expect(isValidUsername('user_01')).toBe(true);
    expect(isValidUsername('a'.repeat(32))).toBe(true);
  });

  it('拒绝过短、过长与非法字符', () => {
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('a'.repeat(33))).toBe(false);
    expect(isValidUsername('user-name')).toBe(false);
    expect(isValidUsername('中文用户')).toBe(false);
  });
});

describe('isValidPassword', () => {
  it('6-128 位', () => {
    expect(isValidPassword('123456')).toBe(true);
    expect(isValidPassword('a'.repeat(128))).toBe(true);
    expect(isValidPassword('12345')).toBe(false);
    expect(isValidPassword('a'.repeat(129))).toBe(false);
  });
});

describe('isValidFileName', () => {
  it('接受普通与中文文件名', () => {
    expect(isValidFileName('report.pdf')).toBe(true);
    expect(isValidFileName('测试文档.txt')).toBe(true);
    expect(isValidFileName('.gitignore')).toBe(true);
  });

  it('拒绝路径分隔符与控制字符', () => {
    expect(isValidFileName('../etc/passwd')).toBe(false);
    expect(isValidFileName('a/b.txt')).toBe(false);
    expect(isValidFileName('a\\b.txt')).toBe(false);
    expect(isValidFileName('bad\u0000name')).toBe(false);
  });

  it('拒绝 . 与 .. 以及空值', () => {
    expect(isValidFileName('.')).toBe(false);
    expect(isValidFileName('..')).toBe(false);
    expect(isValidFileName('')).toBe(false);
  });

  it('拒绝超长名称', () => {
    expect(isValidFileName('a'.repeat(256))).toBe(false);
  });
});

describe('sanitizeFileName', () => {
  it('路径分隔符替换为下划线', () => {
    expect(sanitizeFileName('a/b\\c.txt')).toBe('a_b_c.txt');
  });

  it('剥离控制字符', () => {
    expect(sanitizeFileName('a\u0001b\u001fc.txt')).toBe('abc.txt');
  });

  it('截断到 255 字符', () => {
    expect(sanitizeFileName('a'.repeat(300)).length).toBe(255);
  });
});

describe('isValidUUID', () => {
  it('识别标准 UUID', () => {
    expect(isValidUUID('4c5a9a24-d771-47ea-8141-8f9427875104')).toBe(true);
    expect(isValidUUID('4C5A9A24-D771-47EA-8141-8F9427875104')).toBe(true);
  });

  it('拒绝其它格式', () => {
    expect(isValidUUID('not-a-uuid')).toBe(false);
    expect(isValidUUID('')).toBe(false);
    expect(isValidUUID('4c5a9a24d77147ea81418f9427875104')).toBe(false);
  });
});

describe('getMimeType', () => {
  it('常见扩展名', () => {
    expect(getMimeType('a.txt')).toBe('text/plain');
    expect(getMimeType('a.PNG')).toBe('image/png');
    expect(getMimeType('a.pdf')).toBe('application/pdf');
    expect(getMimeType('a.md')).toBe('text/markdown');
  });

  it('未知扩展名降级为二进制', () => {
    expect(getMimeType('a.unknownext')).toBe('application/octet-stream');
    expect(getMimeType('noext')).toBe('application/octet-stream');
  });

  it('多个点取最后一段', () => {
    expect(getMimeType('archive.tar.gz')).toBe('application/gzip');
  });
});

describe('isTextFile', () => {
  it('文本与 JSON/XML 视为可编辑', () => {
    expect(isTextFile('text/plain')).toBe(true);
    expect(isTextFile('application/json')).toBe(true);
    expect(isTextFile('application/xml')).toBe(true);
    expect(isTextFile('image/png')).toBe(false);
  });
});

describe('随机码生成', () => {
  it('邀请码为 8 位、排除易混字符', () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  });

  it('分享 token 为 16 位字母数字', () => {
    const token = generateShareToken();
    expect(token).toHaveLength(16);
    expect(token).toMatch(/^[a-zA-Z0-9]{16}$/);
  });

  it('连续生成不重复', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateShareToken()));
    expect(codes.size).toBe(50);
  });
});

describe('formatBytes', () => {
  it('按 1024 进制换算', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(10737418240)).toBe('10 GB');
  });
});
