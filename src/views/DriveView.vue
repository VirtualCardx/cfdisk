<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '@/components/layout/AppLayout.vue';
import FileThumb from '@/components/files/FileThumb.vue';
import ContextMenu from '@/components/drive/ContextMenu.vue';
import { useFilesStore, type FileItem, type PathItem, type SortField } from '@/stores/files';
import { useUploadStore, type UploadTask } from '@/stores/upload';
import { useUIStore } from '@/stores/ui';
import { api } from '@/api/client';
import { downloadWithProgress } from '@/utils/download';

const route = useRoute();
const router = useRouter();
const filesStore = useFilesStore();
const uploadStore = useUploadStore();
const uiStore = useUIStore();

const fileInput = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);
const newFolderName = ref('');
const renameValue = ref('');
const showNewFolderModal = ref(false);
const showRenameModal = ref(false);
const showDeleteModal = ref(false);
const showShareModal = ref(false);
const selectedForAction = ref<FileItem | null>(null);

const sharePassword = ref('');
const shareExpiry = ref('');
const shareReferers = ref('');
const createdShareUrl = ref('');

// 批量操作
const showMoveModal = ref(false);
const showBatchDeleteModal = ref(false);
const showInfoModal = ref(false);
const infoFile = ref<FileItem | null>(null);
const batchBusy = ref(false);
const moveTargetId = ref<string | null>(null);
/** 本次移动的目标条目 id（选择集或单个右键项） */
const moveIds = ref<string[]>([]);
const moveFolders = ref<FileItem[]>([]);
const movePath = ref<PathItem[]>([]);
const moveLoading = ref(false);

// 搜索
interface SearchResult extends FileItem {
  path: string[];
}
const searchQuery = ref('');
const searchResults = ref<SearchResult[]>([]);
const searching = ref(false);
const searchInputRef = ref<HTMLInputElement | null>(null);
let searchTimer: number | undefined;

// 排序
const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
  { value: 'updated_at', label: 'Modified' },
  { value: 'type', label: 'Type' },
];
const sortOpen = ref(false);
const sortWrap = ref<HTMLElement | null>(null);

const sortFieldLabel = computed(
  () => SORT_OPTIONS.find((o) => o.value === filesStore.sortBy)?.label ?? 'Name'
);
const sortArrow = computed(() => (filesStore.sortOrder === 'asc' ? '↑' : '↓'));

/**
 * 点菜单里的字段：换字段就按该字段的默认方向排；
 * 点的是当前字段则只翻转方向——不用先切走再切回来。
 */
function chooseSort(field: SortField): void {
  if (filesStore.sortBy === field) {
    filesStore.toggleSortOrder();
    return;
  }
  filesStore.setSort(field);
}

function onSortOutside(event: PointerEvent): void {
  if (!sortOpen.value) return;
  if (!sortWrap.value?.contains(event.target as Node)) sortOpen.value = false;
}

function onSortKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && sortOpen.value) sortOpen.value = false;
}

const moveTargetName = computed(() => {
  if (!moveTargetId.value) return 'My Files';
  return movePath.value.find((node) => node.id === moveTargetId.value)?.name ?? 'Selected folder';
});

onMounted(() => {
  loadFiles();
  document.addEventListener('pointerdown', onSortOutside);
  document.addEventListener('keydown', onSortKeydown);
});

onUnmounted(() => {
  document.removeEventListener('pointerdown', onSortOutside);
  document.removeEventListener('keydown', onSortKeydown);
});

watch(() => route.params.id, () => {
  loadFiles();
});

function loadFiles() {
  const folderId = route.params.id as string | undefined;
  filesStore.fetchFiles(folderId || null);
}

function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) {
    uploadStore.addToQueue(input.files, filesStore.currentFolderId);
    input.value = '';
  }
}

function handleDrop(event: DragEvent) {
  dragOver.value = false;
  const files = event.dataTransfer?.files;
  if (files?.length) {
    uploadStore.addToQueue(files, filesStore.currentFolderId);
  }
}

function openFolder(file: FileItem) {
  if (file.type === 'folder') {
    router.push(`/drive/folder/${file.id}`);
  } else {
    openPreview(file);
  }
}

function openPreview(file: FileItem) {
  uiStore.openModal('preview', file);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '-';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * 上传项右侧的状态文案。
 *
 * 队列最多同时跑 3 个任务，排在后面的任务在轮到自己之前进度恒为 0——
 * 直接显示 "0%" 会被误读成"卡住了/没有进度"，所以待传的明确标成 Queued。
 */
function uploadStatusText(task: UploadTask): string {
  if (task.status === 'completed') return 'Done';
  if (task.status === 'error') return task.error || 'Failed';
  if (task.status === 'pending') return 'Queued';
  return `${task.progress}%`;
}

/** 批量上传的文件数目统计（总数 / 已上传 / 剩余 / 失败） */
const uploadStats = computed(() => uploadStore.stats);

/** 面板标题：正在传 / 排队中 / 全部完成 / 有失败 */
const uploadHeadline = computed(() => {
  const s = uploadStats.value;
  if (s.remaining > 0) return s.uploading > 0 ? 'Uploading…' : 'Preparing…';
  return s.failed > 0 ? 'Finished with errors' : 'All uploads complete';
});

function getFileIcon(file: FileItem): string {
  if (file.type === 'folder') return 'folder';
  const mime = file.mime_type || '';
  const name = file.name.toLowerCase();
  
  // 图片
  if (mime.startsWith('image/')) return 'image';
  
  // 视频
  if (mime.startsWith('video/')) return 'video';
  
  // 音频
  if (mime.startsWith('audio/')) return 'audio';
  
  // PDF
  if (mime.includes('pdf')) return 'pdf';
  
  // Word 文档
  if (mime.includes('word') || mime.includes('document') || 
      name.endsWith('.doc') || name.endsWith('.docx')) return 'doc';
  
  // Excel 表格
  if (mime.includes('sheet') || mime.includes('excel') || 
      name.endsWith('.xls') || name.endsWith('.xlsx') || name.endsWith('.csv')) return 'sheet';
  
  // 文本文件
  if (mime.startsWith('text/') || mime.includes('json') || 
      name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.log')) return 'text';
  
  // 压缩包
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('archive') ||
      name.endsWith('.zip') || name.endsWith('.rar') || name.endsWith('.7z') || 
      name.endsWith('.tar') || name.endsWith('.gz') || name.endsWith('.bz2')) return 'archive';
  
  // 代码文件
  const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.vue', '.html', '.css', '.scss', 
                          '.py', '.java', '.cpp', '.c', '.h', '.go', '.rs', '.php', 
                          '.rb', '.swift', '.kt', '.sql', '.sh', '.bash', '.yaml', '.yml'];
  if (codeExtensions.some(ext => name.endsWith(ext))) return 'code';
  
  return 'file';
}

async function createFolder() {
  if (!newFolderName.value.trim()) return;
  try {
    await filesStore.createFolder(newFolderName.value.trim());
    showNewFolderModal.value = false;
    newFolderName.value = '';
    uiStore.showToast('Folder created', 'success');
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to create folder', 'error');
  }
}

function openRenameModal(file: FileItem) {
  selectedForAction.value = file;
  renameValue.value = file.name;
  showRenameModal.value = true;
}

async function renameFile() {
  if (!selectedForAction.value || !renameValue.value.trim()) return;
  try {
    await filesStore.renameFile(selectedForAction.value.id, renameValue.value.trim());
    showRenameModal.value = false;
    uiStore.showToast('Renamed successfully', 'success');
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to rename', 'error');
  }
}

function openDeleteModal(file: FileItem) {
  selectedForAction.value = file;
  showDeleteModal.value = true;
}

async function deleteFile() {
  if (!selectedForAction.value) return;
  try {
    await filesStore.deleteFile(selectedForAction.value.id);
    showDeleteModal.value = false;
    uiStore.showToast('Moved to trash', 'success');
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to delete', 'error');
  }
}

function openShareModal(file: FileItem) {
  // 弹窗里会出现密码框，浏览器密码管理器可能趁机把账号名写进搜索框，
  // 这里先把手上的关键词记下来，关闭弹窗时据此校正
  lastTypedSearch = searchQuery.value;
  searchInputRef.value?.blur();

  selectedForAction.value = file;
  sharePassword.value = '';
  shareExpiry.value = '';
  shareReferers.value = '';
  createdShareUrl.value = '';
  showShareModal.value = true;
}

watch(showShareModal, (open) => {
  if (open) return;
  // 关闭后清掉可能被自动填充进去的内容（部分密码管理器不派发 input 事件）
  const el = searchInputRef.value;
  if (!el) return;
  if (el.value !== lastTypedSearch) {
    el.value = lastTypedSearch;
  }
  if (searchQuery.value !== lastTypedSearch) {
    searchQuery.value = lastTypedSearch;
  }
});

async function createShare() {
  if (!selectedForAction.value) return;
  try {
    const body: Record<string, unknown> = { file_id: selectedForAction.value.id };
    if (sharePassword.value) body.password = sharePassword.value;
    if (shareExpiry.value) body.expires_in = parseInt(shareExpiry.value) * 3600;
    if (shareReferers.value) {
      body.allowed_referers = shareReferers.value.split(',').map(s => s.trim()).filter(Boolean);
    }
    
    const data = await api.post<{ share: { access_token: string } }>('/share', body);
    createdShareUrl.value = `${window.location.origin}/s/${data.share.access_token}`;
    uiStore.showToast('Share link created', 'success');
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to create share', 'error');
  }
}

function copyShareUrl() {
  navigator.clipboard.writeText(createdShareUrl.value);
  uiStore.showToast('Link copied to clipboard', 'success');
}

// ---------- 下载 ----------

interface DownloadState {
  /** 0-100；服务端没给 Content-Length 时为 null（不确定态） */
  percent: number | null;
  done: boolean;
}

/** 按文件 ID 记录进行中的下载，卡片底部据此显示进度 */
const downloads = reactive<Record<string, DownloadState>>({});

function isDownloading(id: string): boolean {
  return downloads[id] !== undefined;
}

function downloadLabel(id: string): string {
  const state = downloads[id];
  if (!state) return '';
  if (state.done) return 'Downloaded';
  return state.percent === null ? 'Downloading…' : `Downloading ${state.percent}%`;
}

async function downloadFile(file: FileItem) {
  if (file.type === 'folder') return;
  // 下载中重复点击直接忽略；刚完成的那 1.4 秒允许再下一次
  const current = downloads[file.id];
  if (current && !current.done) return;

  downloads[file.id] = { percent: 0, done: false };
  const token = localStorage.getItem('token');

  try {
    await downloadWithProgress(`/api/files/${file.id}/download`, file.name, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      // 已知大小才能对大文件启用多段并行下载
      expectedSize: file.size,
      onProgress: (progress) => {
        downloads[file.id] = { percent: progress.percent, done: false };
      },
    });

    // 停在 100% 一小会儿，让用户确实看到"已完成"，而不是一闪而过
    downloads[file.id] = { percent: 100, done: true };
    window.setTimeout(() => {
      if (downloads[file.id]?.done) delete downloads[file.id];
    }, 1400);
  } catch (e: unknown) {
    delete downloads[file.id];
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to download', 'error');
  }
}

// ---------- 单击 / 右键 / 多选 ----------

/** 单击卡片：文件夹进入下一层，文件直接打开预览 */
function activateItem(file: FileItem) {
  openFolder(file);
}

/**
 * 右键目标是否处于「批量语境」。
 *
 * 只有右键点在被选中、且选择集不止一项的条目上，菜单才按批量展示与执行；
 * 点在未选中项上时，即使别处还选着几项，也只看这一项——右键本身不改变选择状态，
 * 所以不能拿 `selected.size` 单独判断，否则会去操作一批用户根本没指向的文件。
 */
function isBatchContext(file: FileItem): boolean {
  return filesStore.selected.has(file.id) && filesStore.selected.size > 1;
}

/** 右键弹出的条目（仅用于给卡片加一圈定位高亮，不参与选择状态） */
const menuTargetId = computed(() => uiStore.contextMenu?.file?.id ?? null);

/** 当前菜单是否为批量语境，交给菜单组件决定展示哪些项 */
const menuBatch = computed(() => {
  const target = uiStore.contextMenu?.file;
  return target ? isBatchContext(target) : false;
});

/**
 * 右键：只决定「菜单对准谁」，不改动选择状态。
 *
 * 之前这里会把没选中的条目补进选择集，副作用是右键顺带把已有选择清掉了；
 * 现在选择状态只由圆点单击改变，右键纯粹是打开菜单。
 */
function openContextMenu(event: MouseEvent, file: FileItem) {
  event.preventDefault();
  uiStore.showContextMenu(event.clientX, event.clientY, file);
}

/** 菜单项统一入口：动作需要的目标文件由菜单组件带回来 */
function onMenuAction(key: string, file: FileItem) {
  uiStore.hideContextMenu();

  const batch = isBatchContext(file);

  switch (key) {
    case 'open':
      activateItem(file);
      break;
    case 'share':
      openShareModal(file);
      break;
    case 'download':
      void downloadFile(file);
      break;
    case 'rename':
      openRenameModal(file);
      break;
    case 'move':
      // 批量语境移动整批选择集；单项语境只移动右键的那一项
      openMoveModal(batch ? undefined : file);
      break;
    case 'info':
      infoFile.value = file;
      showInfoModal.value = true;
      break;
    case 'delete':
      // 同上：删整批还是删单项，跟着菜单当时展示的语境走
      if (batch) {
        showBatchDeleteModal.value = true;
      } else {
        openDeleteModal(file);
      }
      break;
  }
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const infoTypeLabel = computed(() => {
  const file = infoFile.value;
  if (!file) return '';
  if (file.type === 'folder') return 'Folder';
  return file.mime_type || 'File';
});

const infoSizeText = computed(() => {
  const file = infoFile.value;
  if (!file) return '';
  return file.type === 'folder' ? '—' : formatBytes(file.size);
});

const infoLocation = computed(() => filesStore.breadcrumbs.map((item) => item.name).join(' / '));

// ---------- 搜索 ----------

// 记录用户真实输入过的关键词，用来识别浏览器自动填充写入的内容
let lastTypedSearch = '';

function onSearchInput(event?: Event) {
  const target = event?.target as HTMLInputElement | undefined;

  // 浏览器密码管理器（弹窗里出现密码框时）会在输入框没有焦点的情况下把账号名写进来，
  // 这类写入不是用户操作，直接回滚，避免搜索框被填上 "admin" 之类的用户名
  if (target && document.activeElement !== target) {
    if (searchQuery.value !== lastTypedSearch) {
      searchQuery.value = lastTypedSearch;
    }
    if (target.value !== lastTypedSearch) {
      target.value = lastTypedSearch;
    }
    return;
  }

  lastTypedSearch = searchQuery.value;
  window.clearTimeout(searchTimer);
  const query = searchQuery.value.trim();

  if (!query) {
    searchResults.value = [];
    searching.value = false;
    return;
  }

  searchTimer = window.setTimeout(runSearch, 250);
}

async function runSearch() {
  const query = searchQuery.value.trim();
  if (!query) return;

  searching.value = true;
  try {
    const data = await api.get<{ query: string; files: SearchResult[] }>(
      `/files/search?q=${encodeURIComponent(query)}`
    );
    // 结果返回时用户可能已经改了关键词，丢弃过期响应
    if (searchQuery.value.trim() === data.query) {
      searchResults.value = data.files;
    }
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Search failed', 'error');
  } finally {
    searching.value = false;
  }
}

function exitSearch() {
  window.clearTimeout(searchTimer);
  searchQuery.value = '';
  lastTypedSearch = '';
  searchResults.value = [];
  searching.value = false;
}

function openSearchResult(item: SearchResult) {
  if (item.type === 'folder') {
    exitSearch();
    router.push(`/drive/folder/${item.id}`);
  } else {
    openPreview(item);
  }
}

// ---------- 批量操作 ----------

async function loadMoveFolders(folderId: string | null) {
  moveLoading.value = true;
  try {
    const params = new URLSearchParams();
    if (folderId) params.set('parent_id', folderId);

    const data = await api.get<{ files: FileItem[]; path: PathItem[] }>(
      `/files?${params.toString()}`
    );
    moveFolders.value = data.files.filter((item) => item.type === 'folder');
    movePath.value = data.path;
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to load folders', 'error');
  } finally {
    moveLoading.value = false;
  }
}

/**
 * 打开移动弹窗。
 *
 * 不传 `file` 时移动整个选择集（工具栏按钮、多选右键都走这条）；
 * 传了 `file` 就只移动这一项——右键未选中项时不需要先把它选上。
 */
function openMoveModal(file?: FileItem) {
  const ids = file ? [file.id] : Array.from(filesStore.selected);
  if (ids.length === 0) return;

  moveIds.value = ids;
  moveTargetId.value = null;
  movePath.value = [];
  showMoveModal.value = true;
  loadMoveFolders(null);
}

function enterMoveFolder(folder: FileItem) {
  // 不能把文件夹移动到它自己里面
  if (moveIds.value.includes(folder.id)) return;
  moveTargetId.value = folder.id;
  loadMoveFolders(folder.id);
}

async function confirmMove() {
  batchBusy.value = true;
  try {
    await filesStore.moveFiles(moveTargetId.value, moveIds.value);
    showMoveModal.value = false;
    uiStore.showToast('Moved successfully', 'success');
    exitSearch();
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to move', 'error');
  } finally {
    batchBusy.value = false;
  }
}

async function deleteSelectedFiles() {
  batchBusy.value = true;
  try {
    await filesStore.deleteSelected();
    showBatchDeleteModal.value = false;
    uiStore.showToast('Moved to trash', 'success');
    exitSearch();
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to delete', 'error');
  } finally {
    batchBusy.value = false;
  }
}
</script>

<template>
  <AppLayout>
    <div class="drive-view">
      <header class="drive-header">
        <nav class="breadcrumb">
          <template v-for="(item, index) in filesStore.breadcrumbs" :key="item.id ?? 'root'">
            <span v-if="index > 0" class="breadcrumb-sep">/</span>
            <router-link
              :to="item.id ? `/drive/folder/${item.id}` : '/drive'"
              class="breadcrumb-item"
              :class="{ active: index === filesStore.breadcrumbs.length - 1 }"
            >
              {{ item.name }}
            </router-link>
          </template>
        </nav>

        <div class="header-actions">
          <div v-if="!searchQuery.trim()" ref="sortWrap" class="sort-control">
            <button
              type="button"
              class="btn-icon sort-btn"
              :class="{ active: sortOpen }"
              :aria-expanded="sortOpen"
              aria-haspopup="listbox"
              :aria-label="`Sort by ${sortFieldLabel}, ${filesStore.sortOrder === 'asc' ? 'ascending' : 'descending'}`"
              title="Sort"
              @click="sortOpen = !sortOpen"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M7 4v16"/><path d="M4 7l3-3 3 3"/>
                <path d="M17 20V4"/><path d="M14 17l3 3 3-3"/>
              </svg>
              <span class="sort-btn-label">{{ sortFieldLabel }}</span>
              <span class="sort-dir" aria-hidden="true">{{ sortArrow }}</span>
            </button>

            <div v-if="sortOpen" class="sort-menu" role="listbox" aria-label="Sort by">
              <div class="sort-menu-head">Sort by</div>
              <button
                v-for="option in SORT_OPTIONS"
                :key="option.value"
                type="button"
                role="option"
                class="sort-option"
                :class="{ active: filesStore.sortBy === option.value }"
                :aria-selected="filesStore.sortBy === option.value"
                @click="chooseSort(option.value)"
              >
                <span class="sort-option-label">{{ option.label }}</span>
                <svg
                  v-if="filesStore.sortBy === option.value"
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <line x1="12" y1="19" x2="12" y2="5"/>
                  <polyline v-if="filesStore.sortOrder === 'asc'" points="6 11 12 5 18 11"/>
                  <polyline v-else points="6 13 12 19 18 13"/>
                </svg>
              </button>
            </div>
          </div>

          <div class="search-box">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              type="search"
              name="cfdisk-file-search"
              placeholder="Search files"
              autocomplete="off"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              data-form-type="other"
              data-lpignore="true"
              @input="onSearchInput"
              @change="onSearchInput"
              @keyup.esc="exitSearch"
            />
          </div>
          <button class="btn-icon" @click="showNewFolderModal = true" title="New Folder">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
              <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
            </svg>
          </button>
          <button class="btn-primary" @click="fileInput?.click()">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
            </svg>
            Upload
          </button>
          <input
            ref="fileInput"
            type="file"
            multiple
            style="display: none"
            @change="handleFileSelect"
          />
        </div>
      </header>

      <!-- 批量操作条 -->
      <div v-if="filesStore.selected.size > 0 && !searchQuery.trim()" class="selection-bar">
        <span class="selection-count">{{ filesStore.selected.size }} selected</span>
        <button class="btn-secondary" @click="filesStore.selectAll()">Select all</button>
        <button class="btn-secondary" @click="filesStore.clearSelection()">Clear</button>
        <button class="btn-secondary" @click="openMoveModal()">Move to…</button>
        <button class="btn-danger" @click="showBatchDeleteModal = true">Delete</button>
      </div>

      <div
        class="file-area"
        :class="{ 'drag-over': dragOver }"
        @dragover.prevent="dragOver = true"
        @dragleave="dragOver = false"
        @drop.prevent="handleDrop"
      >
        <!-- 搜索结果 -->
        <div v-if="searchQuery.trim()" class="search-panel">
          <div v-if="searching" class="loading">Searching…</div>
          <div v-else-if="searchResults.length === 0" class="empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <p>No matches for "{{ searchQuery }}"</p>
            <p class="hint">Try a shorter keyword</p>
          </div>
          <div v-else class="search-list">
            <div
              v-for="item in searchResults"
              :key="item.id"
              class="search-row"
              @click="openSearchResult(item)"
            >
              <svg v-if="item.type === 'folder'" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="#fbbf24">
                <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
              </svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
              <div class="search-info">
                <span class="search-name">{{ item.name }}</span>
                <span class="search-path">{{ item.path.length ? item.path.join(' / ') : 'My Files' }}</span>
              </div>
              <span class="search-size">{{ item.type === 'file' ? formatBytes(item.size) : '' }}</span>
            </div>
          </div>
        </div>

        <template v-else>
        <div v-if="filesStore.loading" class="loading">Loading...</div>

        <div v-else-if="filesStore.sortedFiles.length === 0" class="empty-state">
          <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
          <p>This folder is empty</p>
          <p class="hint">Drop files here or click Upload</p>
        </div>

        <div v-else class="file-grid" @click.self="filesStore.clearSelection()">
          <div
            v-for="file in filesStore.sortedFiles"
            :key="file.id"
            class="file-item"
            :class="{
              selected: filesStore.selected.has(file.id),
              'menu-target': menuTargetId === file.id,
            }"
            @click="activateItem(file)"
            @contextmenu="openContextMenu($event, file)"
          >
            <!-- 多选圆点：hover / 已选中时可见；空心=未选，实心带勾=已选 -->
            <button
              type="button"
              class="select-dot"
              :class="{ checked: filesStore.selected.has(file.id) }"
              :aria-pressed="filesStore.selected.has(file.id)"
              :title="filesStore.selected.has(file.id) ? 'Deselect' : 'Select'"
              @click.stop="filesStore.toggleSelect(file.id)"
            >
              <svg
                v-if="filesStore.selected.has(file.id)"
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </button>
            <div class="file-icon" :class="getFileIcon(file)">
              <!-- 图片：优先显示真实缩略图，加载失败或大图回退为图标 -->
              <FileThumb v-if="getFileIcon(file) === 'image'" :file="file">
                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
              </FileThumb>
              <!-- 文件夹 -->
              <svg v-else-if="file.type === 'folder'" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
              </svg>
              <!-- 视频 -->
              <svg v-else-if="getFileIcon(file) === 'video'" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
                <line x1="7" y1="2" x2="7" y2="22"/>
                <line x1="17" y1="2" x2="17" y2="22"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <line x1="2" y1="7" x2="7" y2="7"/>
                <line x1="2" y1="17" x2="7" y2="17"/>
                <line x1="17" y1="17" x2="22" y2="17"/>
                <line x1="17" y1="7" x2="22" y2="7"/>
              </svg>
              <!-- 音频 -->
              <svg v-else-if="getFileIcon(file) === 'audio'" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M9 18V5l12-2v13"/>
                <circle cx="6" cy="18" r="3"/>
                <circle cx="18" cy="16" r="3"/>
              </svg>
              <!-- PDF -->
              <svg v-else-if="getFileIcon(file) === 'pdf'" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <path d="M10 13l-2 2 2 2"/>
                <path d="M14 13l2 2-2 2"/>
              </svg>
              <!-- 文档 -->
              <svg v-else-if="getFileIcon(file) === 'doc'" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
              <!-- 表格 -->
              <svg v-else-if="getFileIcon(file) === 'sheet'" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="8" y1="13" x2="16" y2="13"/>
                <line x1="8" y1="17" x2="16" y2="17"/>
                <line x1="10" y1="9" x2="8" y2="9"/>
              </svg>
              <!-- 文本 -->
              <svg v-else-if="getFileIcon(file) === 'text'" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <line x1="10" y1="9" x2="8" y2="9"/>
              </svg>
              <!-- 压缩包 -->
              <svg v-else-if="getFileIcon(file) === 'archive'" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 8v13H3V8"/>
                <path d="M1 3h22v5H1z"/>
                <path d="M10 12h4"/>
              </svg>
              <!-- 代码文件 -->
              <svg v-else-if="getFileIcon(file) === 'code'" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <polyline points="16 18 22 12 16 6"/>
                <polyline points="8 6 2 12 8 18"/>
              </svg>
              <!-- 默认文件 -->
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
              </svg>
            </div>
            <div class="file-name" :title="file.name">{{ file.name }}</div>
            <div class="file-meta">
              <span>{{ formatBytes(file.size) }}</span>
              <span>{{ formatDate(file.updated_at) }}</span>
            </div>
            <div class="file-actions">
              <!-- 预览按钮已移除：单击卡片本身就会打开预览，这里保留的是不常用的次要动作 -->
              <button
                data-action="download"
                @click.stop="downloadFile(file)"
                :disabled="!!downloads[file.id]"
                :title="isDownloading(file.id) ? downloadLabel(file.id) : 'Download'"
                :class="{
                  'is-downloading': !!downloads[file.id] && !downloads[file.id]?.done,
                  'is-done': downloads[file.id]?.done,
                }"
                v-if="file.type === 'file'"
              >
                <!-- 下载中：转圈；已完成：勾 -->
                <span v-if="downloads[file.id] && !downloads[file.id]?.done" class="mini-spinner" aria-hidden="true"></span>
                <svg v-else-if="downloads[file.id]?.done" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                </svg>
              </button>
              <button @click.stop="openShareModal(file)" title="Share">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                </svg>
              </button>
              <button @click.stop="openRenameModal(file)" title="Rename">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
              <button @click.stop="openDeleteModal(file)" title="Delete" class="delete-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                </svg>
              </button>
            </div>

            <!-- 下载状态：常驻卡片底部，鼠标移开、按钮消失后依然能看到进度 -->
            <div
              v-if="downloads[file.id]"
              class="download-badge"
              :class="{ done: downloads[file.id]?.done }"
              role="status"
              :aria-label="downloadLabel(file.id)"
            >
              <div class="download-badge-track">
                <div
                  class="download-badge-fill"
                  :class="{
                    indeterminate: downloads[file.id]?.percent === null,
                    done: downloads[file.id]?.done,
                  }"
                  :style="{ width: `${downloads[file.id]?.percent ?? 0}%` }"
                ></div>
              </div>
              <span class="download-badge-text">{{ downloadLabel(file.id) }}</span>
            </div>
          </div>
        </div>
        </template>
      </div>

      <!-- Upload Progress -->
      <div v-if="uploadStore.queue.length > 0" class="upload-panel">
        <div class="upload-header">
          <div class="upload-head-top">
            <span
              class="upload-title"
              :class="{
                'is-done': uploadStats.remaining === 0 && uploadStats.failed === 0,
                'is-error': uploadStats.remaining === 0 && uploadStats.failed > 0,
              }"
            >
              {{ uploadHeadline }}
            </span>
            <button @click="uploadStore.clearCompleted">Clear completed</button>
          </div>
          <div v-if="uploadStore.isBatch" class="upload-counts">
            <span class="upload-count">
              <b>{{ uploadStats.total }}</b> total
            </span>
            <span class="upload-count-dot">·</span>
            <span class="upload-count is-done">
              <b>{{ uploadStats.completed }}</b> uploaded
            </span>
            <span class="upload-count-dot">·</span>
            <span class="upload-count is-left">
              <b>{{ uploadStats.remaining }}</b> remaining
            </span>
            <template v-if="uploadStats.failed > 0">
              <span class="upload-count-dot">·</span>
              <span class="upload-count is-failed">
                <b>{{ uploadStats.failed }}</b> failed
              </span>
            </template>
          </div>
        </div>
        <div
          v-if="uploadStore.isBatch"
          class="upload-overall"
          :class="{ 'is-done': uploadStats.remaining === 0 && uploadStats.failed === 0 }"
          role="progressbar"
          :aria-valuenow="uploadStats.percent"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="`${uploadStats.completed} of ${uploadStats.total} files uploaded`"
        >
          <div class="upload-overall-track">
            <div class="upload-overall-bar" :style="{ width: `${uploadStats.percent}%` }"></div>
          </div>
          <span class="upload-overall-label">{{ uploadStats.percent }}%</span>
        </div>
        <div class="upload-list">
          <div v-for="task in uploadStore.queue" :key="task.id" class="upload-item">
            <span class="upload-name">{{ task.file.name }}</span>
            <div class="upload-progress">
              <div class="upload-bar" :style="{ width: `${task.progress}%` }"></div>
            </div>
            <span class="upload-status" :class="task.status">
              {{ uploadStatusText(task) }}
            </span>
          </div>
        </div>
      </div>

      <!-- New Folder Modal -->
      <Teleport to="body">
        <div v-if="showNewFolderModal" class="modal-overlay" @click="showNewFolderModal = false">
          <div class="modal" @click.stop>
            <h3>New Folder</h3>
            <input v-model="newFolderName" placeholder="Folder name" @keyup.enter="createFolder" />
            <div class="modal-actions">
              <button class="btn-secondary" @click="showNewFolderModal = false">Cancel</button>
              <button class="btn-primary" @click="createFolder">Create</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Rename Modal -->
      <Teleport to="body">
        <div v-if="showRenameModal" class="modal-overlay" @click="showRenameModal = false">
          <div class="modal" @click.stop>
            <h3>Rename</h3>
            <input v-model="renameValue" @keyup.enter="renameFile" />
            <div class="modal-actions">
              <button class="btn-secondary" @click="showRenameModal = false">Cancel</button>
              <button class="btn-primary" @click="renameFile">Rename</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Delete Modal -->
      <Teleport to="body">
        <div v-if="showDeleteModal" class="modal-overlay" @click="showDeleteModal = false">
          <div class="modal" @click.stop>
            <h3>Move to Trash?</h3>
            <p>Are you sure you want to move "{{ selectedForAction?.name }}" to trash?</p>
            <div class="modal-actions">
              <button class="btn-secondary" @click="showDeleteModal = false">Cancel</button>
              <button class="btn-danger" @click="deleteFile">Delete</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Share Modal -->
      <Teleport to="body">
        <div v-if="showShareModal" class="modal-overlay" @click="showShareModal = false">
          <div class="modal" @click.stop>
            <h3>Share "{{ selectedForAction?.name }}"</h3>
            <div v-if="!createdShareUrl" class="share-form" autocomplete="off">
              <div class="form-group">
                <label>Password (optional)</label>
                <input
                  v-model="sharePassword"
                  type="password"
                  name="cfdisk-share-password"
                  placeholder="Leave empty for no password"
                  autocomplete="new-password"
                  data-form-type="other"
                  data-lpignore="true"
                />
              </div>
              <div class="form-group">
                <label>Expiry (hours, optional)</label>
                <input
                  v-model="shareExpiry"
                  type="number"
                  name="cfdisk-share-expiry"
                  placeholder="e.g., 24"
                  autocomplete="off"
                  data-form-type="other"
                  data-lpignore="true"
                />
              </div>
              <div class="form-group">
                <label>Allowed domains (comma-separated, for hotlink protection)</label>
                <input
                  v-model="shareReferers"
                  name="cfdisk-share-referers"
                  placeholder="e.g., example.com, *.mysite.com"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  data-form-type="other"
                  data-lpignore="true"
                />
              </div>
              <div class="modal-actions">
                <button class="btn-secondary" @click="showShareModal = false">Cancel</button>
                <button class="btn-primary" @click="createShare">Create Link</button>
              </div>
            </div>
            <div v-else class="share-result">
              <input :value="createdShareUrl" readonly class="share-url" />
              <div class="modal-actions">
                <button class="btn-primary" @click="copyShareUrl">Copy Link</button>
                <button class="btn-secondary" @click="showShareModal = false">Close</button>
              </div>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Move Modal -->
      <Teleport to="body">
        <div v-if="showMoveModal" class="modal-overlay" @click="showMoveModal = false">
          <div class="modal modal-wide" @click.stop>
            <h3>Move {{ moveIds.length }} item(s)</h3>

            <div class="picker-path">
              <button class="link-btn" @click="moveTargetId = null; loadMoveFolders(null)">My Files</button>
              <template v-for="node in movePath" :key="node.id">
                <span class="picker-sep">/</span>
                <button class="link-btn" @click="moveTargetId = node.id; loadMoveFolders(node.id)">{{ node.name }}</button>
              </template>
            </div>

            <div class="picker-list">
              <div v-if="moveLoading" class="picker-empty">Loading…</div>
              <div v-else-if="moveFolders.length === 0" class="picker-empty">No subfolders here</div>
              <template v-else>
                <div v-for="folder in moveFolders" :key="folder.id" class="picker-row">
                  <button
                    class="picker-select"
                    :class="{ active: moveTargetId === folder.id }"
                    :disabled="filesStore.selected.has(folder.id)"
                    @click="moveTargetId = folder.id"
                  >
                    {{ folder.name }}
                    <span v-if="filesStore.selected.has(folder.id)" class="picker-note">moving</span>
                  </button>
                  <button class="picker-open" title="Open folder" @click="enterMoveFolder(folder)">›</button>
                </div>
              </template>
            </div>

            <p class="picker-hint">Destination: <strong>{{ moveTargetName }}</strong></p>

            <div class="modal-actions">
              <button class="btn-secondary" @click="showMoveModal = false">Cancel</button>
              <button class="btn-primary" :disabled="batchBusy" @click="confirmMove">Move here</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Batch Delete Modal -->
      <Teleport to="body">
        <div v-if="showBatchDeleteModal" class="modal-overlay" @click="showBatchDeleteModal = false">
          <div class="modal" @click.stop>
            <h3>Move {{ filesStore.selected.size }} item(s) to Trash?</h3>
            <p>Deleted items stay in Trash until you empty it.</p>
            <div class="modal-actions">
              <button class="btn-secondary" @click="showBatchDeleteModal = false">Cancel</button>
              <button class="btn-danger" :disabled="batchBusy" @click="deleteSelectedFiles">Delete</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Item Details Modal -->
      <Teleport to="body">
        <div v-if="showInfoModal" class="modal-overlay" @click="showInfoModal = false">
          <div class="modal" @click.stop>
            <h3>{{ infoFile?.name }}</h3>
            <dl class="info-list">
              <div><dt>Type</dt><dd>{{ infoTypeLabel }}</dd></div>
              <div><dt>Size</dt><dd>{{ infoSizeText }}</dd></div>
              <div><dt>Location</dt><dd>{{ infoLocation }}</dd></div>
              <div><dt>Modified</dt><dd>{{ infoFile ? formatDateTime(infoFile.updated_at) : '' }}</dd></div>
              <div><dt>Created</dt><dd>{{ infoFile ? formatDateTime(infoFile.created_at) : '' }}</dd></div>
            </dl>
            <div class="modal-actions">
              <button class="btn-secondary" @click="showInfoModal = false">Close</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 右键菜单（Teleport 到 body，避免被卡片的 overflow 裁切） -->
      <ContextMenu
        :batch="menuBatch"
        :selection-count="filesStore.selected.size"
        @action="onMenuAction"
      />
    </div>
  </AppLayout>
</template>

<style scoped>
.drive-view {
  padding: 1.5rem;
}

.drive-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.125rem;
  flex-wrap: wrap;
  overflow: hidden;
}

.breadcrumb-sep {
  color: #94a3b8;
}

.breadcrumb-item {
  color: #64748b;
  text-decoration: none;
}

.breadcrumb-item:hover {
  color: #1e40af;
}

.breadcrumb-item.active {
  color: #0f172a;
  font-weight: 600;
}

.header-actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.btn-icon {
  background: #fff;
  border: 1px solid #cbd5e1;
  padding: 0.625rem;
  border-radius: 8px;
  cursor: pointer;
  color: #64748b;
  transition: all 0.2s;
}

.btn-icon:hover {
  background: #f1f5f9;
  color: #1e40af;
}

/* 排序控件 */
.sort-control {
  position: relative;
}

.sort-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  white-space: nowrap;
}

.sort-btn.active {
  background: #eff6ff;
  border-color: #93c5fd;
  color: #1e40af;
}

.sort-btn-label {
  font-size: 0.8125rem;
  font-weight: 500;
}

.sort-dir {
  font-size: 0.75rem;
  line-height: 1;
  color: currentColor;
  opacity: 0.75;
}

.sort-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 40;
  min-width: 176px;
  padding: 0.375rem;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);
}

.sort-menu-head {
  padding: 0.25rem 0.5rem 0.375rem;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #94a3b8;
}

.sort-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem;
  border: none;
  border-radius: 7px;
  background: transparent;
  font-size: 0.875rem;
  color: #334155;
  text-align: left;
  cursor: pointer;
}

.sort-option:hover {
  background: #f1f5f9;
}

.sort-option.active {
  background: #eff6ff;
  color: #1d4ed8;
  font-weight: 600;
}

.btn-primary {
  background: #1e40af;
  color: #fff;
  border: none;
  padding: 0.625rem 1.25rem;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  transition: background 0.2s;
  white-space: nowrap;
}

.btn-primary:hover {
  background: #1e3a8a;
}

.btn-secondary {
  background: #fff;
  color: #334155;
  border: 1px solid #cbd5e1;
  padding: 0.625rem 1.25rem;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
}

.btn-danger {
  background: #dc2626;
  color: #fff;
  border: none;
  padding: 0.625rem 1.25rem;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
}

.file-area {
  background: #fff;
  border-radius: 12px;
  min-height: 500px;
  border: 2px dashed transparent;
  transition: border-color 0.2s;
}

.file-area.drag-over {
  border-color: #3b82f6;
  background: #eff6ff;
}

.loading, .empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 400px;
  color: #94a3b8;
}

.empty-state svg {
  margin-bottom: 1rem;
}

.empty-state .hint {
  font-size: 0.875rem;
  margin-top: 0.5rem;
}

.file-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 1rem;
  padding: 1.5rem;
}

@media (max-width: 768px) {
  .drive-view {
    padding: 1rem;
  }

  .drive-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .breadcrumb {
    font-size: 1rem;
    max-width: 100%;
  }

  /* 工具栏在窄屏本来就要换行，排序按钮只留图标 + 方向，
     当前字段在展开的菜单里用对勾 + 箭头标记 */
  .sort-btn-label {
    display: none;
  }

  .sort-btn {
    padding: 0.625rem 0.5rem;
  }

  /* 多了排序按钮后，固定 180px 的搜索框会把 Upload 挤到单独一行；
     让它可收缩，四个控件能收在一行里 */
  .search-box {
    flex: 1 1 140px;
    min-width: 0;
  }

  .search-box input {
    width: 100%;
    min-width: 0;
  }

  .file-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 0.75rem;
    padding: 1rem;
  }

  .file-item {
    padding: 0.75rem;
  }

  /* 不再单独写死高度：相框比例由 aspect-ratio 统一控制，
     移动端卡片更窄，高度会跟着缩小，不需要另一套数值。 */

  .file-name {
    font-size: 0.875rem;
  }
}

/* 注意：上传面板的移动端样式写在文件末尾（基础规则之后），
   否则同优先级下会被后面声明的桌面端规则覆盖 —— 之前就是这样导致
   面板压在底部导航栏上、最后一个上传项被遮住。 */

@media (max-width: 480px) {
  /* 小屏把工具栏间距和上传按钮收紧，四个控件才排得进一行 */
  .header-actions {
    gap: 0.5rem;
  }

  .header-actions .btn-primary {
    padding: 0.625rem 0.875rem;
  }

  .file-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 0.5rem;
    padding: 0.5rem;
  }

  .file-item {
    min-width: 0; /* 防止 flex 子项溢出 */
  }

  .file-name {
    font-size: 0.8rem;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .file-meta {
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .btn-primary span {
    display: none;
  }

  .btn-primary {
    padding: 0.625rem;
  }
}

/* 360px 这类更窄的屏幕：搜索框再让一点宽度，四个控件仍能排一行 */
@media (max-width: 400px) {
  .search-box {
    flex-basis: 110px;
  }
}

.file-item {
  background: #f8fafc;
  border-radius: 12px;
  padding: 1rem;
  cursor: pointer;
  transition: all 0.2s;
  position: relative;
}

.file-item:hover {
  background: #e0f2fe;
  transform: translateY(-2px);
}

.file-item.selected {
  background: #dbeafe;
  box-shadow: 0 0 0 2px #3b82f6;
}

/*
 * 右键定位框。
 *
 * 右键不再改变选择状态，所以未选中的卡片被右键时没有任何视觉反馈，
 * 菜单「对准的是哪一张」会变得含糊。这里只描一圈浅蓝虚线外框，
 * 表达「菜单目标」而不表示「已选中」——实心蓝框仍然专属于选择状态。
 */
.file-item.menu-target {
  box-shadow: 0 0 0 2px #93c5fd;
}

.file-item.selected.menu-target {
  box-shadow:
    0 0 0 2px #3b82f6,
    0 0 0 4px #bfdbfe;
}

/*
 * 多选圆点。
 *
 * 单击卡片现在是「打开」，多选只能从这里进，所以它的可发现性很重要：
 * 平时透明，鼠标悬浮卡片时浮现成空心圈（暗示「这里可以点」），
 * 选中后变实心蓝底 + 白勾并常驻。
 *
 * z-index 需要高于缩略图（.thumb-img 无 z-index）和右上角操作按钮（2），
 * 否则圆点会被盖住、点不到。
 */
.select-dot {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 3;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1.5px solid #cbd5e1;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.92);
  color: #ffffff;
  cursor: pointer;
  opacity: 0;
  transform: scale(0.85);
  transition:
    opacity 0.15s ease,
    transform 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease;
}

.file-item:hover .select-dot,
.select-dot.checked,
.select-dot:focus-visible {
  opacity: 1;
  transform: scale(1);
}

.select-dot:hover {
  border-color: #2563eb;
}

.select-dot.checked {
  background: #2563eb;
  border-color: #2563eb;
}

.select-dot.checked:hover {
  background: #1d4ed8;
  border-color: #1d4ed8;
}

/* 触屏没有 hover，圆点必须常显，否则根本没入口进多选 */
@media (hover: none) {
  .select-dot {
    opacity: 1;
    transform: scale(1);
  }
}

.file-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  /*
   * 固定 4:3 而不是写死 96px 高。
   *
   * 卡片宽度由 grid 的 minmax(180px, 1fr) 决定，会随视口在 150~200px 之间浮动；
   * 高度写死时相框比例跟着一起漂（窄屏 1.5:1、宽屏接近 2:1），竖图被裁得只剩中间一条。
   * 用 aspect-ratio 锁定比例后，任何列宽下相框都一致，缩略图区域的高度自然跟着宽度走。
   *
   * 4:3 的取舍：手机照片 4:3 / 3:4 都接近满铺，16:9 截图上下留白约 12%，
   * 1:1 方图左右留白约 12%，是各类素材里最均衡的一档。
   */
  aspect-ratio: 4 / 3;
  margin-bottom: 0.75rem;
}

.file-icon.folder svg {
  color: #f59e0b;
}

.file-icon.image svg {
  color: #3b82f6;
}

.file-icon.video svg {
  color: #ef4444;
}

.file-icon.audio svg {
  color: #8b5cf6;
}

.file-icon.pdf svg {
  color: #f97316;
}

.file-icon.doc svg {
  color: #2563eb;
}

.file-icon.sheet svg {
  color: #22c55e;
}

.file-icon.text svg {
  color: #64748b;
}

.file-icon.archive svg {
  color: #f59e0b;
}

.file-icon.code svg {
  color: #0f172a;
}

.file-icon.file svg {
  color: #94a3b8;
}

.file-name {
  font-weight: 500;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 0.5rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-clamp: 2;
  word-break: break-all;
  max-width: 100%;
}

.file-meta {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: #94a3b8;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.file-actions {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  display: flex;
  gap: 0.25rem;
  opacity: 0;
  transition: opacity 0.2s;
  /* 图片缩略图会占满卡片上方的图标区，必须明确声明层级，否则按钮会被压在图片下面 */
  z-index: 2;
}

.file-item:hover .file-actions {
  opacity: 1;
}

@media (max-width: 768px) {
  .file-actions {
    opacity: 1;
    position: static;
    justify-content: center;
    margin-top: 0.5rem;
  }

  .file-item:hover .file-actions {
    opacity: 1;
  }
}

.file-actions button {
  /* 半透明白底 + 背景模糊：按钮压在照片上时依然能看清图标 */
  background: rgba(255, 255, 255, 0.92);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  border: none;
  padding: 0.375rem;
  border-radius: 6px;
  cursor: pointer;
  color: #475569;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
}

.file-actions button:hover {
  color: #1e40af;
}

.file-actions .delete-btn:hover {
  color: #dc2626;
}

.file-actions button:disabled {
  cursor: default;
  color: #2563eb;
}

.file-actions button.is-done {
  color: #16a34a;
}

/* 下载中按钮里的转圈图标 */
.mini-spinner {
  display: block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(37, 99, 235, 0.25);
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: mini-spin 0.7s linear infinite;
}

@keyframes mini-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 下载状态条：贴在卡片底部，鼠标移出（按钮消失）后仍可见 */
.download-badge {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 0.4rem 0.7rem 0.5rem;
  border-radius: 0 0 12px 12px;
  background: linear-gradient(to top, rgba(255, 255, 255, 0.97), rgba(255, 255, 255, 0.82));
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  /* 不拦截点击，卡片仍然可以选中 / 双击打开 */
  pointer-events: none;
  z-index: 3;
}

.download-badge-track {
  height: 3px;
  border-radius: 999px;
  background: #dbeafe;
  overflow: hidden;
}

.download-badge-fill {
  height: 100%;
  width: 0;
  border-radius: inherit;
  background: #2563eb;
  transition: width 0.18s ease-out;
}

/* 服务端没给 Content-Length 时用滑动条表示"还在下"，不要假装知道百分比 */
.download-badge-fill.indeterminate {
  width: 35%;
  animation: download-slide 1.1s ease-in-out infinite;
}

.download-badge-fill.done {
  width: 100% !important;
  background: #16a34a;
}

.download-badge-text {
  font-size: 0.7rem;
  font-weight: 500;
  line-height: 1.1;
  text-align: center;
  color: #1d4ed8;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.download-badge.done .download-badge-text {
  color: #15803d;
}

@keyframes download-slide {
  0% {
    transform: translateX(-110%);
  }
  100% {
    transform: translateX(320%);
  }
}

@media (max-width: 768px) {
  /* 移动端的操作按钮是静态布局排在卡片底部，
     进度条必须回到文档流里，否则会盖住按钮 */
  .download-badge {
    position: static;
    margin-top: 0.45rem;
    padding: 0.4rem 0.5rem;
    border-radius: 8px;
    background: #eff6ff;
    gap: 0.25rem;
  }

  .download-badge-text {
    font-size: 0.66rem;
  }
}

.upload-panel {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  width: 320px;
  /* 卡片右上角的操作按钮是 z-index:2 的绝对定位元素，会盖在 fixed 面板之上，
     点 "Clear completed" 时会被某个被遮住的删除按钮截获 → 给面板抬到它们之上 */
  z-index: 50;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}

.upload-header {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.75rem 1rem;
  background: #f1f5f9;
  border-bottom: 1px solid #e2e8f0;
}

.upload-head-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  font-weight: 500;
}

.upload-title {
  font-size: 0.875rem;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.upload-title.is-done {
  color: #15803d;
}

.upload-title.is-error {
  color: #b45309;
}

.upload-header button {
  flex: none;
  background: none;
  border: none;
  color: #1e40af;
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0;
}

.upload-header button:hover {
  text-decoration: underline;
}

/*
 * 文件数目统计行：`12 total · 5 uploaded · 6 remaining`。
 * 允许换行——中文/窄屏 + 出现 failed 时一行放不下，硬撑会挤成省略号。
 */
.upload-counts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 0.3rem;
  font-size: 0.75rem;
  color: #64748b;
  font-variant-numeric: tabular-nums;
}

.upload-count b {
  font-weight: 600;
  color: #0f172a;
}

.upload-count.is-done b {
  color: #16a34a;
}

.upload-count.is-left b {
  color: #1e40af;
}

.upload-count.is-failed b {
  color: #dc2626;
}

.upload-count-dot {
  color: #cbd5e1;
}

/* 队列整体进度条（只在批量上传时出现） */
.upload-overall {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
}

.upload-overall-track {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: #e2e8f0;
  overflow: hidden;
}

.upload-overall-bar {
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, #3b82f6, #6366f1);
  transition: width 0.3s ease;
}

.upload-overall.is-done .upload-overall-bar {
  background: #22c55e;
}

.upload-overall-label {
  min-width: 2.2rem;
  font-size: 0.7rem;
  color: #64748b;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.upload-list {
  max-height: 240px;
  overflow-y: auto;
}

.upload-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #eee;
}

.upload-name {
  flex: 1;
  font-size: 0.875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.upload-progress {
  width: 60px;
  height: 4px;
  background: #e2e8f0;
  border-radius: 2px;
  overflow: hidden;
}

.upload-bar {
  height: 100%;
  background: #3b82f6;
  transition: width 0.3s;
}

.upload-status {
  font-size: 0.75rem;
  /* 状态可能是 Done / Queued / 100% / 错误文案，固定 40px 会挤成两行 */
  min-width: 3.5rem;
  text-align: right;
  white-space: nowrap;
}

.upload-status.pending {
  color: #94a3b8;
}

.upload-status.completed {
  color: #22c55e;
}

.upload-status.error {
  color: #dc2626;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: #fff;
  border-radius: 12px;
  padding: 1.5rem;
  width: 90%;
  max-width: 400px;
}

.modal h3 {
  margin: 0 0 1rem;
}

.modal input {
  width: 100%;
  padding: 0.75rem;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  font-size: 1rem;
  margin-bottom: 1rem;
}

.modal input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.modal-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}

.form-group {
  margin-bottom: 1rem;
}

/* 「查看详细信息」的键值列表 */
.info-list {
  display: grid;
  gap: 0.75rem;
  margin: 0 0 1.25rem;
}

.info-list > div {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 0.75rem;
  align-items: start;
}

.info-list dt {
  font-size: 0.8125rem;
  color: #64748b;
}

.info-list dd {
  margin: 0;
  font-size: 0.8125rem;
  color: #0f172a;
  word-break: break-word;
}

.form-group label {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.5rem;
  color: #334155;
}

.share-url {
  font-family: monospace;
  font-size: 0.875rem;
}

/* 搜索框 */
.search-box {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.75rem;
  background: #fff;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  color: #94a3b8;
}

.search-box:focus-within {
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.search-box input {
  border: none;
  outline: none;
  padding: 0.625rem 0;
  font-size: 0.875rem;
  width: 180px;
  color: #0f172a;
  background: transparent;
}

/* 批量操作条 */
.selection-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.625rem 0.875rem;
  margin-bottom: 1rem;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 10px;
}

.selection-count {
  font-weight: 600;
  color: #1e40af;
  margin-right: auto;
}

.selection-bar .btn-secondary,
.selection-bar .btn-danger {
  padding: 0.375rem 0.75rem;
  font-size: 0.875rem;
}

/* 搜索结果 */
.search-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.search-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  border-radius: 10px;
  cursor: pointer;
  color: #475569;
}

.search-row:hover {
  background: #f1f5f9;
}

.search-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.search-name {
  font-weight: 500;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-path {
  font-size: 0.75rem;
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-size {
  font-size: 0.75rem;
  color: #94a3b8;
  white-space: nowrap;
}

/* 文件夹选择器 */
.modal-wide {
  max-width: 520px;
}

.picker-path {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-wrap: wrap;
  font-size: 0.875rem;
  margin-bottom: 0.75rem;
}

.link-btn {
  background: none;
  border: none;
  padding: 0;
  color: #1e40af;
  cursor: pointer;
  font-size: inherit;
}

.link-btn:hover {
  text-decoration: underline;
}

.picker-sep {
  color: #94a3b8;
}

.picker-list {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.25rem;
  margin-bottom: 0.75rem;
}

.picker-empty {
  padding: 1rem;
  text-align: center;
  color: #94a3b8;
  font-size: 0.875rem;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.picker-select {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: none;
  border: none;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  color: #0f172a;
  font-size: 0.875rem;
}

.picker-select:hover:not(:disabled) {
  background: #f1f5f9;
}

.picker-select.active {
  background: #dbeafe;
  color: #1e40af;
  font-weight: 600;
}

.picker-select:disabled {
  color: #cbd5e1;
  cursor: not-allowed;
}

.picker-note {
  font-size: 0.75rem;
  color: #94a3b8;
}

.picker-open {
  background: none;
  border: none;
  color: #64748b;
  cursor: pointer;
  font-size: 1.125rem;
  line-height: 1;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
}

.picker-open:hover {
  background: #f1f5f9;
  color: #1e40af;
}

.picker-hint {
  font-size: 0.875rem;
  color: #64748b;
  margin-bottom: 1rem;
}

/*
 * 上传进度面板的移动端样式。
 *
 * 必须放在所有基础规则之后：CSS 同优先级下后者胜出，之前这段写在文件
 * 中间（基础 .upload-panel 之前），bottom/width 全被桌面端规则覆盖，
 * 面板实际 bottom 只有 24px，直接压在 60px 高的底部导航栏上，
 * 于是最后一个上传项被导航栏遮住、看不到进度。
 *
 * 另外用 flex + max-height 兜住小屏：文件一多，列表内部滚动，
 * 面板整体不会长到超出屏幕顶部。
 */
@media (max-width: 768px) {
  .upload-panel {
    left: 0.75rem;
    right: 0.75rem;
    /* 左+右 + width:auto 才是撑满，三者同时写会变成过度约束 */
    width: auto;
    /* 底部导航栏 60px + 间距 + iPhone home indicator 安全区 */
    bottom: calc(60px + 1rem + env(safe-area-inset-bottom, 0px));
    /* 最多占 60% 屏高，剩下的让给文件列表；超出的项在列表内部滚动 */
    max-height: 60vh;
    max-height: 60dvh;
    display: flex;
    flex-direction: column;
  }

  .upload-header {
    flex: none;
  }

  .upload-list {
    flex: 1 1 auto;
    max-height: none;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }

  .upload-item {
    /* 触屏上太窄会把文件名压成一两个字，状态也跟着挤 */
    padding: 0.625rem 0.875rem;
  }
}
</style>
