import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api } from '@/api/client';

export interface FileItem {
  id: string;
  parent_id: string | null;
  name: string;
  type: 'file' | 'folder';
  mime_type: string | null;
  size: number;
  created_at: number;
  updated_at: number;
  /** 服务端签发的小图地址；没有缩略图时为 null（历史文件首次显示时补生成） */
  thumb_url?: string | null;
}

export interface PathItem {
  id: string;
  name: string;
}

/** 列表可排序字段：名称 / 大小 / 创建时间 / 修改时间 / 类型 */
export type SortField = 'name' | 'size' | 'created_at' | 'updated_at' | 'type';
export type SortOrder = 'asc' | 'desc';

const SORT_FIELDS: SortField[] = ['name', 'size', 'created_at', 'updated_at', 'type'];
const SORT_STORAGE_KEY = 'cfdisk:sort';

/**
 * 每个字段的默认方向。
 *
 * 名称、类型从小到大读起来自然；大小和修改时间则是「大的/新的在前」更有用——
 * 第一次点「大小」却得到一堆 0 字节文件排在最前，会让人以为没生效。
 */
export function defaultSortOrder(field: SortField): SortOrder {
  return field === 'size' || field === 'created_at' || field === 'updated_at' ? 'desc' : 'asc';
}

/** 取扩展名（小写）；`.gitignore`、`README` 这类没有扩展名的返回空串 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 「文件类型」的排序键。
 *
 * 优先用扩展名而不是 mime：用户理解的类型是 `jpg`/`png`/`pdf`，
 * 而 mime（`image/jpeg`、`application/pdf`）会把同一类拆得七零八落。
 * 没有扩展名时退回 mime 的子类型，避免一堆文件全落到同一个空键上。
 */
function typeKeyOf(file: FileItem): string {
  if (file.type === 'folder') return '';
  const ext = extensionOf(file.name);
  if (ext) return ext;
  const mime = file.mime_type || '';
  const slash = mime.indexOf('/');
  return slash === -1 ? mime : mime.slice(slash + 1);
}

/** 名称比较：`file2` 排在 `file10` 前面，且忽略大小写差异 */
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * 排序主逻辑（纯函数，便于单测）。
 *
 * 文件夹恒定在前——即使按大小降序也不会被一堆大文件挤到后面；
 * 主键相同时用名称升序兜底，保证同一份数据每次渲染顺序一致（不会因为
 * 底层数组顺序变化而跳动）。
 */
export function sortFileItems(items: FileItem[], by: SortField, order: SortOrder): FileItem[] {
  const primary = (a: FileItem, b: FileItem): number => {
    switch (by) {
      case 'name':
        return nameCollator.compare(a.name, b.name);
      case 'size':
        return a.size - b.size;
      case 'created_at':
        return a.created_at - b.created_at;
      case 'updated_at':
        return a.updated_at - b.updated_at;
      case 'type':
        return nameCollator.compare(typeKeyOf(a), typeKeyOf(b));
    }
  };

  const compare = (a: FileItem, b: FileItem): number => {
    const cmp = primary(a, b);
    if (cmp !== 0) return order === 'desc' ? -cmp : cmp;
    return nameCollator.compare(a.name, b.name);
  };

  const folders = items.filter((f) => f.type === 'folder').sort(compare);
  const regular = items.filter((f) => f.type === 'file').sort(compare);
  return [...folders, ...regular];
}

function readStoredSort(): { by: SortField; order: SortOrder } | null {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { by?: string; order?: string };
    if (!parsed.by || !SORT_FIELDS.includes(parsed.by as SortField)) return null;

    return {
      by: parsed.by as SortField,
      order: parsed.order === 'desc' ? 'desc' : 'asc',
    };
  } catch {
    // 隐私模式 / 存储被禁用时不必报错，退回默认排序即可
    return null;
  }
}

export const useFilesStore = defineStore('files', () => {
  const files = ref<FileItem[]>([]);
  const currentFolderId = ref<string | null>(null);
  const path = ref<PathItem[]>([]);
  const loading = ref(false);
  const selected = ref<Set<string>>(new Set());
  const viewMode = ref<'grid' | 'list'>('grid');

  const storedSort = typeof localStorage === 'undefined' ? null : readStoredSort();
  const sortBy = ref<SortField>(storedSort?.by ?? 'name');
  const sortOrder = ref<SortOrder>(storedSort?.order ?? 'asc');

  const sortedFiles = computed(() => sortFileItems(files.value, sortBy.value, sortOrder.value));

  const breadcrumbs = computed(() => [{ id: null, name: 'My Files' }, ...path.value]);

  const selectedFiles = computed(() => files.value.filter((f) => selected.value.has(f.id)));

  async function fetchFiles(folderId: string | null = null): Promise<void> {
    loading.value = true;
    try {
      const params = new URLSearchParams();
      if (folderId) params.set('parent_id', folderId);
      params.set('sort', sortBy.value);
      params.set('order', sortOrder.value);

      const data = await api.get<{ files: FileItem[]; path: PathItem[] }>(
        `/files?${params.toString()}`
      );
      files.value = data.files;
      path.value = data.path;
      currentFolderId.value = folderId;
      selected.value.clear();
    } finally {
      loading.value = false;
    }
  }

  async function createFolder(name: string): Promise<FileItem> {
    const data = await api.post<{ folder: FileItem }>('/folders', {
      name,
      parent_id: currentFolderId.value,
    });
    files.value.push(data.folder);
    return data.folder;
  }

  async function renameFile(fileId: string, name: string): Promise<void> {
    const file = files.value.find((f) => f.id === fileId);
    if (!file) return;

    const endpoint = file.type === 'folder' ? `/folders/${fileId}/rename` : `/files/${fileId}/rename`;
    await api.put(endpoint, { name });

    const index = files.value.findIndex((f) => f.id === fileId);
    if (index !== -1) {
      const currentFile = files.value[index];
      if (currentFile) {
        files.value[index] = { ...currentFile, name };
      }
    }
  }

  async function deleteFile(fileId: string): Promise<void> {
    const file = files.value.find((f) => f.id === fileId);
    if (!file) return;

    const endpoint = file.type === 'folder' ? `/folders/${fileId}` : `/files/${fileId}`;
    await api.delete(endpoint);

    files.value = files.value.filter((f) => f.id !== fileId);
    selected.value.delete(fileId);
  }

  async function deleteSelected(): Promise<void> {
    const ids = Array.from(selected.value);
    for (const id of ids) {
      await deleteFile(id);
    }
  }

  /**
   * 移动文件到目标文件夹。
   *
   * `ids` 不传时用当前选择集；右键单项但该项没被选中时，调用方会显式传 `[id]`——
   * 这样「右键 → 移动」不必先把这一项塞进选择集，选择状态保持原样。
   */
  async function moveFiles(targetId: string | null, ids?: string[]): Promise<void> {
    const moving = ids ?? Array.from(selected.value);
    if (moving.length === 0) return;

    await api.put('/files/move', { ids: moving, target_id: targetId });

    const moved = new Set(moving);
    files.value = files.value.filter((f) => !moved.has(f.id));
    moving.forEach((id) => selected.value.delete(id));
  }

  function toggleSelect(fileId: string): void {
    if (selected.value.has(fileId)) {
      selected.value.delete(fileId);
    } else {
      selected.value.add(fileId);
    }
  }

  function selectAll(): void {
    files.value.forEach((f) => selected.value.add(f.id));
  }

  function clearSelection(): void {
    selected.value.clear();
  }

  function setThumbUrl(fileId: string, thumbUrl: string | null): void {
    const index = files.value.findIndex((f) => f.id === fileId);
    if (index === -1) return;
    const current = files.value[index];
    if (current) {
      files.value[index] = { ...current, thumb_url: thumbUrl };
    }
  }

  function setViewMode(mode: 'grid' | 'list'): void {
    viewMode.value = mode;
  }

  function persistSort(): void {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ by: sortBy.value, order: sortOrder.value }));
    } catch {
      // 存不了就算了，不影响本次会话内的排序
    }
  }

  /**
   * 切换排序字段。`order` 不传时用该字段的默认方向，
   * 避免「点大小还是升序」这种反直觉的结果。
   */
  function setSort(by: SortField, order: SortOrder = defaultSortOrder(by)): void {
    sortBy.value = by;
    sortOrder.value = order;
    persistSort();
  }

  /** 同一字段上再点一次：只翻转方向 */
  function toggleSortOrder(): void {
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
    persistSort();
  }

  return {
    files,
    currentFolderId,
    path,
    loading,
    selected,
    viewMode,
    sortBy,
    sortOrder,
    sortedFiles,
    breadcrumbs,
    selectedFiles,
    fetchFiles,
    createFolder,
    renameFile,
    deleteFile,
    deleteSelected,
    moveFiles,
    toggleSelect,
    selectAll,
    clearSelection,
    setThumbUrl,
    setViewMode,
    setSort,
    toggleSortOrder,
  };
});
