<script setup lang="ts">
import { ref, onMounted } from 'vue';
import AppLayout from '@/components/layout/AppLayout.vue';
import { api } from '@/api/client';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';

interface TrashItem {
  id: string;
  name: string;
  type: 'file' | 'folder';
  mime_type: string | null;
  size: number;
  deleted_at: number;
}

const uiStore = useUIStore();
const authStore = useAuthStore();
const items = ref<TrashItem[]>([]);
const loading = ref(true);
const showDeleteModal = ref(false);
const selectedItem = ref<TrashItem | null>(null);
const showEmptyModal = ref(false);

onMounted(() => {
  loadTrash();
});

async function loadTrash() {
  loading.value = true;
  try {
    const data = await api.get<{ files: TrashItem[] }>('/trash');
    items.value = data.files;
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to load trash', 'error');
  } finally {
    loading.value = false;
  }
}

async function restoreItem(item: TrashItem) {
  try {
    await api.post(`/trash/${item.id}/restore`);
    items.value = items.value.filter((i) => i.id !== item.id);
    uiStore.showToast('Restored successfully', 'success');
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to restore', 'error');
  }
}

function confirmDelete(item: TrashItem) {
  selectedItem.value = item;
  showDeleteModal.value = true;
}

async function permanentDelete() {
  if (!selectedItem.value) return;
  try {
    await api.delete(`/trash/${selectedItem.value.id}`);
    const deletedSize = selectedItem.value.size;
    items.value = items.value.filter((i) => i.id !== selectedItem.value!.id);
    authStore.updateStorageUsed(-deletedSize);
    showDeleteModal.value = false;
    uiStore.showToast('Permanently deleted', 'success');
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to delete', 'error');
  }
}

async function emptyTrash() {
  try {
    await api.delete('/trash');
    const totalSize = items.value.reduce((sum, i) => sum + i.size, 0);
    items.value = [];
    authStore.updateStorageUsed(-totalSize);
    showEmptyModal.value = false;
    uiStore.showToast('Trash emptied', 'success');
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to empty trash', 'error');
  }
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
    hour: '2-digit',
    minute: '2-digit',
  });
}
</script>

<template>
  <AppLayout>
    <div class="trash-view">
      <header class="page-header">
        <h1>Trash</h1>
        <button v-if="items.length > 0" class="btn-danger" @click="showEmptyModal = true">
          Empty Trash
        </button>
      </header>

      <div v-if="loading" class="loading">Loading...</div>

      <div v-else-if="items.length === 0" class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
        </svg>
        <p>Trash is empty</p>
      </div>

      <div v-else class="trash-list">
        <div v-for="item in items" :key="item.id" class="trash-item">
          <div class="item-icon">
            <svg v-if="item.type === 'folder'" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#fbbf24">
              <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
            </svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
            </svg>
          </div>
          <div class="item-info">
            <span class="item-name">{{ item.name }}</span>
            <span class="item-meta">{{ formatBytes(item.size) }} &middot; Deleted {{ formatDate(item.deleted_at) }}</span>
          </div>
          <div class="item-actions">
            <button class="btn-secondary" @click="restoreItem(item)">Restore</button>
            <button class="btn-danger-outline" @click="confirmDelete(item)">Delete Forever</button>
          </div>
        </div>
      </div>

      <Teleport to="body">
        <div v-if="showDeleteModal" class="modal-overlay" @click="showDeleteModal = false">
          <div class="modal" @click.stop>
            <h3>Delete Forever?</h3>
            <p>This will permanently delete "{{ selectedItem?.name }}". This action cannot be undone.</p>
            <div class="modal-actions">
              <button class="btn-secondary" @click="showDeleteModal = false">Cancel</button>
              <button class="btn-danger" @click="permanentDelete">Delete Forever</button>
            </div>
          </div>
        </div>
      </Teleport>

      <Teleport to="body">
        <div v-if="showEmptyModal" class="modal-overlay" @click="showEmptyModal = false">
          <div class="modal" @click.stop>
            <h3>Empty Trash?</h3>
            <p>All {{ items.length }} items will be permanently deleted. This action cannot be undone.</p>
            <div class="modal-actions">
              <button class="btn-secondary" @click="showEmptyModal = false">Cancel</button>
              <button class="btn-danger" @click="emptyTrash">Empty Trash</button>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
  </AppLayout>
</template>

<style scoped>
.trash-view {
  padding: 1.5rem;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.page-header h1 {
  font-size: 1.5rem;
  font-weight: 600;
}

.loading, .empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 400px;
  color: #94a3b8;
  background: #fff;
  border-radius: 12px;
}

.empty-state svg {
  margin-bottom: 1rem;
}

.trash-list {
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
}

.trash-item {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid #f1f5f9;
}

.trash-item:last-child {
  border-bottom: none;
}

.item-icon {
  color: #94a3b8;
}

.item-info {
  flex: 1;
  min-width: 0;
}

.item-name {
  display: block;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-meta {
  font-size: 0.875rem;
  color: #94a3b8;
}

.item-actions {
  display: flex;
  gap: 0.5rem;
}

.btn-secondary {
  background: #fff;
  color: #334155;
  border: 1px solid #e2e8f0;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
}

.btn-danger {
  background: #dc2626;
  color: #fff;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
}

.btn-danger-outline {
  background: #fff;
  color: #dc2626;
  border: 1px solid #dc2626;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
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
  margin: 0 0 0.5rem;
}

.modal p {
  color: #666;
  margin-bottom: 1.5rem;
}

.modal-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}
</style>
