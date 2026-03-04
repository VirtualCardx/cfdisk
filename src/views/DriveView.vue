<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '@/components/layout/AppLayout.vue';
import { useFilesStore, type FileItem } from '@/stores/files';
import { useUploadStore } from '@/stores/upload';
import { useUIStore } from '@/stores/ui';
import { api } from '@/api/client';

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

onMounted(() => {
  loadFiles();
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

function getFileIcon(file: FileItem): string {
  if (file.type === 'folder') return 'folder';
  const mime = file.mime_type || '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('word') || mime.includes('document')) return 'doc';
  if (mime.includes('sheet') || mime.includes('excel')) return 'sheet';
  if (mime.startsWith('text/') || mime.includes('json')) return 'text';
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
  selectedForAction.value = file;
  sharePassword.value = '';
  shareExpiry.value = '';
  shareReferers.value = '';
  createdShareUrl.value = '';
  showShareModal.value = true;
}

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

async function downloadFile(file: FileItem) {
  if (file.type === 'folder') return;
  try {
    const response = await fetch(`/api/files/${file.id}/download`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to download', 'error');
  }
}

function handleContextMenu(event: MouseEvent, file: FileItem) {
  event.preventDefault();
  uiStore.showContextMenu(event.clientX, event.clientY, file);
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

      <div
        class="file-area"
        :class="{ 'drag-over': dragOver }"
        @dragover.prevent="dragOver = true"
        @dragleave="dragOver = false"
        @drop.prevent="handleDrop"
      >
        <div v-if="filesStore.loading" class="loading">Loading...</div>

        <div v-else-if="filesStore.sortedFiles.length === 0" class="empty-state">
          <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
          <p>This folder is empty</p>
          <p class="hint">Drop files here or click Upload</p>
        </div>

        <div v-else class="file-grid">
          <div
            v-for="file in filesStore.sortedFiles"
            :key="file.id"
            class="file-item"
            :class="{ selected: filesStore.selected.has(file.id) }"
            @click="filesStore.toggleSelect(file.id)"
            @dblclick="openFolder(file)"
            @contextmenu="handleContextMenu($event, file)"
          >
            <div class="file-icon" :class="getFileIcon(file)">
              <svg v-if="file.type === 'folder'" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
              </svg>
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
              <button @click.stop="downloadFile(file)" title="Download" v-if="file.type === 'file'">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
          </div>
        </div>
      </div>

      <!-- Upload Progress -->
      <div v-if="uploadStore.queue.length > 0" class="upload-panel">
        <div class="upload-header">
          <span>Uploads ({{ uploadStore.activeUploads }} active)</span>
          <button @click="uploadStore.clearCompleted">Clear completed</button>
        </div>
        <div class="upload-list">
          <div v-for="task in uploadStore.queue" :key="task.id" class="upload-item">
            <span class="upload-name">{{ task.file.name }}</span>
            <div class="upload-progress">
              <div class="upload-bar" :style="{ width: `${task.progress}%` }"></div>
            </div>
            <span class="upload-status" :class="task.status">
              {{ task.status === 'completed' ? 'Done' : task.status === 'error' ? task.error : `${task.progress}%` }}
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
            <div v-if="!createdShareUrl" class="share-form">
              <div class="form-group">
                <label>Password (optional)</label>
                <input v-model="sharePassword" type="password" placeholder="Leave empty for no password" />
              </div>
              <div class="form-group">
                <label>Expiry (hours, optional)</label>
                <input v-model="shareExpiry" type="number" placeholder="e.g., 24" />
              </div>
              <div class="form-group">
                <label>Allowed domains (comma-separated, for hotlink protection)</label>
                <input v-model="shareReferers" placeholder="e.g., example.com, *.mysite.com" />
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
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.125rem;
}

.breadcrumb-sep {
  color: #9ca3af;
}

.breadcrumb-item {
  color: #6b7280;
  text-decoration: none;
}

.breadcrumb-item:hover {
  color: #374151;
}

.breadcrumb-item.active {
  color: #111827;
  font-weight: 600;
}

.header-actions {
  display: flex;
  gap: 0.75rem;
}

.btn-icon {
  background: white;
  border: 1px solid #e5e7eb;
  padding: 0.625rem;
  border-radius: 8px;
  cursor: pointer;
  color: #6b7280;
  transition: all 0.2s;
}

.btn-icon:hover {
  background: #f9fafb;
  color: #374151;
}

.btn-primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  padding: 0.625rem 1.25rem;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  transition: opacity 0.2s;
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-secondary {
  background: white;
  color: #374151;
  border: 1px solid #e5e7eb;
  padding: 0.625rem 1.25rem;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
}

.btn-danger {
  background: #ef4444;
  color: white;
  border: none;
  padding: 0.625rem 1.25rem;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
}

.file-area {
  background: white;
  border-radius: 12px;
  min-height: 500px;
  border: 2px dashed transparent;
  transition: border-color 0.2s;
}

.file-area.drag-over {
  border-color: #667eea;
  background: #f5f3ff;
}

.loading, .empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 400px;
  color: #9ca3af;
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

.file-item {
  background: #f9fafb;
  border-radius: 12px;
  padding: 1rem;
  cursor: pointer;
  transition: all 0.2s;
  position: relative;
}

.file-item:hover {
  background: #f3f4f6;
  transform: translateY(-2px);
}

.file-item.selected {
  background: #ede9fe;
  box-shadow: 0 0 0 2px #8b5cf6;
}

.file-icon {
  display: flex;
  justify-content: center;
  margin-bottom: 0.75rem;
}

.file-icon.folder svg {
  color: #fbbf24;
}

.file-icon.image svg {
  color: #10b981;
}

.file-icon.video svg {
  color: #ef4444;
}

.file-icon.text svg {
  color: #3b82f6;
}

.file-name {
  font-weight: 500;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 0.5rem;
}

.file-meta {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: #9ca3af;
}

.file-actions {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  display: flex;
  gap: 0.25rem;
  opacity: 0;
  transition: opacity 0.2s;
}

.file-item:hover .file-actions {
  opacity: 1;
}

.file-actions button {
  background: white;
  border: none;
  padding: 0.375rem;
  border-radius: 6px;
  cursor: pointer;
  color: #6b7280;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.file-actions button:hover {
  color: #374151;
}

.file-actions .delete-btn:hover {
  color: #ef4444;
}

.upload-panel {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  width: 320px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}

.upload-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.875rem 1rem;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  font-weight: 500;
}

.upload-header button {
  background: none;
  border: none;
  color: #667eea;
  cursor: pointer;
  font-size: 0.75rem;
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
  border-bottom: 1px solid #f3f4f6;
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
  background: #e5e7eb;
  border-radius: 2px;
  overflow: hidden;
}

.upload-bar {
  height: 100%;
  background: linear-gradient(90deg, #667eea, #764ba2);
  transition: width 0.3s;
}

.upload-status {
  font-size: 0.75rem;
  width: 40px;
  text-align: right;
}

.upload-status.completed {
  color: #10b981;
}

.upload-status.error {
  color: #ef4444;
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
  background: white;
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
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  font-size: 1rem;
  margin-bottom: 1rem;
}

.modal-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.5rem;
  color: #374151;
}

.share-url {
  font-family: monospace;
  font-size: 0.875rem;
}
</style>
