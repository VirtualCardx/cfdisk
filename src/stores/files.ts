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
}

export interface PathItem {
  id: string;
  name: string;
}

export const useFilesStore = defineStore('files', () => {
  const files = ref<FileItem[]>([]);
  const currentFolderId = ref<string | null>(null);
  const path = ref<PathItem[]>([]);
  const loading = ref(false);
  const selected = ref<Set<string>>(new Set());
  const viewMode = ref<'grid' | 'list'>('grid');
  const sortBy = ref<'name' | 'size' | 'created_at' | 'updated_at'>('name');
  const sortOrder = ref<'asc' | 'desc'>('asc');

  const sortedFiles = computed(() => {
    const folders = files.value.filter((f) => f.type === 'folder');
    const regularFiles = files.value.filter((f) => f.type === 'file');

    const sortFn = (a: FileItem, b: FileItem) => {
      let cmp = 0;
      switch (sortBy.value) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'size':
          cmp = a.size - b.size;
          break;
        case 'created_at':
          cmp = a.created_at - b.created_at;
          break;
        case 'updated_at':
          cmp = a.updated_at - b.updated_at;
          break;
      }
      return sortOrder.value === 'desc' ? -cmp : cmp;
    };

    return [...folders.sort(sortFn), ...regularFiles.sort(sortFn)];
  });

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

  async function moveFiles(targetId: string | null): Promise<void> {
    const ids = Array.from(selected.value);
    await api.put('/files/move', { ids, target_id: targetId });
    files.value = files.value.filter((f) => !selected.value.has(f.id));
    selected.value.clear();
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

  function setViewMode(mode: 'grid' | 'list'): void {
    viewMode.value = mode;
  }

  function setSort(by: typeof sortBy.value, order: typeof sortOrder.value): void {
    sortBy.value = by;
    sortOrder.value = order;
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
    setViewMode,
    setSort,
  };
});
