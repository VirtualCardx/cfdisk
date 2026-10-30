import { describe, it, expect } from 'vitest';
import { sortFileItems, defaultSortOrder, type FileItem, type SortField } from './files';

let seq = 0;

function makeItem(partial: Partial<FileItem> & { name: string }): FileItem {
  seq += 1;
  return {
    id: `id-${seq}`,
    parent_id: null,
    type: 'file',
    mime_type: 'application/octet-stream',
    size: 0,
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

function folder(name: string, updated = 0): FileItem {
  return makeItem({ name, type: 'folder', size: 0, updated_at: updated, mime_type: null });
}

function file(name: string, size: number, updated = 0, mime = 'application/octet-stream'): FileItem {
  return makeItem({ name, size, updated_at: updated, mime_type: mime });
}

const names = (items: FileItem[]) => items.map((f) => f.name);

describe('sortFileItems', () => {
  const items = [
    file('photo.PNG', 3_000, 100, 'image/png'),
    folder('Archive', 50),
    file('report.pdf', 1_000, 300, 'application/pdf'),
    folder('Photos', 500),
    file('notes.txt', 2_000, 200, 'text/plain'),
    file('data.csv', 1_000, 400, 'text/csv'),
  ];

  it('文件夹恒定排在文件前面，即使按大小降序', () => {
    const result = sortFileItems(items, 'size', 'desc');
    expect(names(result)).toEqual(['Archive', 'Photos', 'photo.PNG', 'notes.txt', 'data.csv', 'report.pdf']);
  });

  it('按名称升序，数字按数值比较（file2 在 file10 之前）', () => {
    const list = [file('file10.txt', 1), file('file2.txt', 1), folder('a')];
    expect(names(sortFileItems(list, 'name', 'asc'))).toEqual(['a', 'file2.txt', 'file10.txt']);
  });

  it('按名称降序只反转组内顺序，文件夹仍在前', () => {
    const list = [file('a.txt', 1), folder('b'), folder('a'), file('b.txt', 1)];
    expect(names(sortFileItems(list, 'name', 'desc'))).toEqual(['b', 'a', 'b.txt', 'a.txt']);
  });

  it('按大小升序 / 降序', () => {
    // report.pdf 与 data.csv 同为 1000 字节，按名称升序兜底 → data.csv 在前
    expect(names(sortFileItems(items, 'size', 'asc')).slice(2)).toEqual([
      'data.csv',
      'report.pdf',
      'notes.txt',
      'photo.PNG',
    ]);
    expect(names(sortFileItems(items, 'size', 'desc')).slice(2)).toEqual([
      'photo.PNG',
      'notes.txt',
      'data.csv',
      'report.pdf',
    ]);
  });

  it('按修改时间降序把最新的排在最前', () => {
    expect(names(sortFileItems(items, 'updated_at', 'desc')).slice(2)).toEqual([
      'data.csv',
      'report.pdf',
      'notes.txt',
      'photo.PNG',
    ]);
  });

  it('按类型排序时用扩展名分组，而不是 mime 全串', () => {
    const list = [
      file('b.pdf', 1, 0, 'application/pdf'),
      file('a.zip', 1, 0, 'application/zip'),
      file('c.png', 1, 0, 'image/png'),
      file('d.csv', 1, 0, 'text/csv'),
    ];
    expect(names(sortFileItems(list, 'type', 'asc'))).toEqual(['d.csv', 'b.pdf', 'c.png', 'a.zip']);
  });

  it('没有扩展名时退回 mime 子类型，同类文件仍会聚在一起', () => {
    const list = [
      file('LICENSE', 1, 0, 'text/plain'),
      file('a.png', 1, 0, 'image/png'),
      file('Makefile', 1, 0, 'text/x-makefile'),
      file('b.txt', 1, 0, 'text/plain'),
    ];
    // 键分别是 plain / png / txt / x-makefile：
    // 没有扩展名的文件也各有类型键，不会全部落到空键上只按名称乱序
    expect(names(sortFileItems(list, 'type', 'asc'))).toEqual(['LICENSE', 'a.png', 'b.txt', 'Makefile']);
  });

  it('主键相同时按名称升序兜底，且不随方向翻转', () => {
    const list = [file('c.txt', 10), file('a.txt', 10), file('b.txt', 10)];
    expect(names(sortFileItems(list, 'size', 'asc'))).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(names(sortFileItems(list, 'size', 'desc'))).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('不修改传入数组', () => {
    const list = [file('b.txt', 2), file('a.txt', 1)];
    const snapshot = names(list);
    sortFileItems(list, 'name', 'asc');
    expect(names(list)).toEqual(snapshot);
  });

  it('空列表不报错', () => {
    expect(sortFileItems([], 'type', 'asc')).toEqual([]);
  });
});

describe('defaultSortOrder', () => {
  it('名称和类型默认升序，大小与时间默认降序', () => {
    const asc: SortField[] = ['name', 'type'];
    const desc: SortField[] = ['size', 'created_at', 'updated_at'];
    asc.forEach((f) => expect(defaultSortOrder(f)).toBe('asc'));
    desc.forEach((f) => expect(defaultSortOrder(f)).toBe('desc'));
  });
});
