<script setup lang="ts">
import { ref, onMounted } from 'vue';
import AppLayout from '@/components/layout/AppLayout.vue';
import { api } from '@/api/client';
import { useUIStore } from '@/stores/ui';

interface ShareItem {
  id: string;
  access_token: string;
  file_name: string;
  file_type: string;
  has_password: boolean;
  expires_at: number | null;
  allowed_referers: string[];
  download_count: number;
  max_downloads: number | null;
  created_at: number;
}

const uiStore = useUIStore();
const shares = ref<ShareItem[]>([]);
const loading = ref(true);
const showDeleteModal = ref(false);
const selectedShare = ref<ShareItem | null>(null);

onMounted(() => {
  loadShares();
});

async function loadShares() {
  loading.value = true;
  try {
    const data = await api.get<{ shares: ShareItem[] }>('/share');
    shares.value = data.shares;
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to load shares', 'error');
  } finally {
    loading.value = false;
  }
}

function getShareUrl(token: string): string {
  return `${window.location.origin}/s/${token}`;
}

function copyUrl(token: string) {
  navigator.clipboard.writeText(getShareUrl(token));
  uiStore.showToast('Link copied to clipboard', 'success');
}

function confirmDelete(share: ShareItem) {
  selectedShare.value = share;
  showDeleteModal.value = true;
}

async function deleteShare() {
  if (!selectedShare.value) return;
  try {
    await api.delete(`/share/${selectedShare.value.id}`);
    shares.value = shares.value.filter((s) => s.id !== selectedShare.value!.id);
    showDeleteModal.value = false;
    uiStore.showToast('Share link deleted', 'success');
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to delete', 'error');
  }
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function isExpired(share: ShareItem): boolean {
  if (!share.expires_at) return false;
  return share.expires_at < Date.now();
}
</script>

<template>
  <AppLayout>
    <div class="shares-view">
      <header class="page-header">
        <h1>Shared Links</h1>
      </header>

      <div v-if="loading" class="loading">Loading...</div>

      <div v-else-if="shares.length === 0" class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
        </svg>
        <p>No shared links yet</p>
        <p class="hint">Share files from My Files to create links</p>
      </div>

      <div v-else class="shares-list">
        <div v-for="share in shares" :key="share.id" class="share-item" :class="{ expired: isExpired(share) }">
          <div class="share-icon">
            <svg v-if="share.file_type === 'folder'" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#fbbf24">
              <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
            </svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
            </svg>
          </div>
          <div class="share-info">
            <span class="share-name">{{ share.file_name }}</span>
            <div class="share-meta">
              <span v-if="share.has_password" class="badge">Password</span>
              <span v-if="share.allowed_referers.length" class="badge">Hotlink Protected</span>
              <span v-if="isExpired(share)" class="badge expired">Expired</span>
              <span v-else-if="share.expires_at">Expires {{ formatDate(share.expires_at) }}</span>
              <span>{{ share.download_count }} downloads</span>
            </div>
          </div>
          <div class="share-url">
            <input :value="getShareUrl(share.access_token)" readonly />
            <button @click="copyUrl(share.access_token)" title="Copy">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
            </button>
          </div>
          <button class="btn-danger-outline" @click="confirmDelete(share)">Delete</button>
        </div>
      </div>

      <Teleport to="body">
        <div v-if="showDeleteModal" class="modal-overlay" @click="showDeleteModal = false">
          <div class="modal" @click.stop>
            <h3>Delete Share Link?</h3>
            <p>This link will no longer work after deletion.</p>
            <div class="modal-actions">
              <button class="btn-secondary" @click="showDeleteModal = false">Cancel</button>
              <button class="btn-danger" @click="deleteShare">Delete</button>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
  </AppLayout>
</template>

<style scoped>
.shares-view {
  padding: 1.5rem;
}

.page-header {
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
  color: #9ca3af;
  background: white;
  border-radius: 12px;
}

.empty-state svg {
  margin-bottom: 1rem;
}

.empty-state .hint {
  font-size: 0.875rem;
  margin-top: 0.5rem;
}

.shares-list {
  background: white;
  border-radius: 12px;
  overflow: hidden;
}

.share-item {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid #f3f4f6;
}

.share-item:last-child {
  border-bottom: none;
}

.share-item.expired {
  opacity: 0.6;
}

.share-icon {
  color: #9ca3af;
}

.share-info {
  flex: 1;
  min-width: 0;
}

.share-name {
  display: block;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.share-meta {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  font-size: 0.75rem;
  color: #9ca3af;
  margin-top: 0.25rem;
  flex-wrap: wrap;
}

.badge {
  background: #e5e7eb;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 500;
}

.badge.expired {
  background: #fee2e2;
  color: #dc2626;
}

.share-url {
  display: flex;
  gap: 0.25rem;
}

.share-url input {
  width: 200px;
  padding: 0.375rem 0.625rem;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 0.75rem;
  font-family: monospace;
  background: #f9fafb;
}

.share-url button {
  background: white;
  border: 1px solid #e5e7eb;
  padding: 0.375rem;
  border-radius: 6px;
  cursor: pointer;
  color: #6b7280;
}

.share-url button:hover {
  background: #f9fafb;
}

.btn-secondary {
  background: white;
  color: #374151;
  border: 1px solid #e5e7eb;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
}

.btn-danger {
  background: #ef4444;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
}

.btn-danger-outline {
  background: white;
  color: #ef4444;
  border: 1px solid #ef4444;
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
  background: white;
  border-radius: 12px;
  padding: 1.5rem;
  width: 90%;
  max-width: 400px;
}

.modal h3 {
  margin: 0 0 0.5rem;
}

.modal p {
  color: #6b7280;
  margin-bottom: 1.5rem;
}

.modal-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}
</style>
