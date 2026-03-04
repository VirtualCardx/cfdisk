<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import AppLayout from '@/components/layout/AppLayout.vue';
import { api } from '@/api/client';
import { useUIStore } from '@/stores/ui';

interface User {
  id: string;
  username: string;
  email: string;
  role: string;
  storage_quota: number;
  storage_used: number;
  is_active: number;
  created_at: number;
}

interface InviteCode {
  id: string;
  code: string;
  creator_username: string;
  user_username: string | null;
  expires_at: number | null;
  created_at: number;
  is_used: boolean;
  is_expired: boolean;
}

interface Stats {
  users: { total: number; active: number; total_storage_used: number };
  files: { total: number; files: number; folders: number; total_size: number };
  shares: { total: number };
}

const uiStore = useUIStore();
const activeTab = ref<'users' | 'invites' | 'stats'>('users');
const users = ref<User[]>([]);
const inviteCodes = ref<InviteCode[]>([]);
const stats = ref<Stats | null>(null);
const loading = ref(true);

const showQuotaModal = ref(false);
const selectedUser = ref<User | null>(null);
const newQuota = ref('');

const showCreateCodeModal = ref(false);
const codeCount = ref(1);
const codeExpiry = ref('');
const createdCodes = ref<string[]>([]);

onMounted(() => {
  loadData();
});

async function loadData() {
  loading.value = true;
  try {
    const [usersData, codesData, statsData] = await Promise.all([
      api.get<{ users: User[] }>('/admin/users'),
      api.get<{ codes: InviteCode[] }>('/admin/invite-codes'),
      api.get<{ stats: Stats }>('/admin/stats'),
    ]);
    users.value = usersData.users;
    inviteCodes.value = codesData.codes;
    stats.value = statsData.stats;
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to load data', 'error');
  } finally {
    loading.value = false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
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

function openQuotaModal(user: User) {
  selectedUser.value = user;
  newQuota.value = String(Math.round(user.storage_quota / (1024 * 1024 * 1024)));
  showQuotaModal.value = true;
}

async function updateQuota() {
  if (!selectedUser.value) return;
  const quotaBytes = parseInt(newQuota.value) * 1024 * 1024 * 1024;
  try {
    await api.put(`/admin/users/${selectedUser.value.id}/quota`, { quota: quotaBytes });
    const user = users.value.find((u) => u.id === selectedUser.value!.id);
    if (user) user.storage_quota = quotaBytes;
    showQuotaModal.value = false;
    uiStore.showToast('Quota updated', 'success');
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to update quota', 'error');
  }
}

async function toggleUserStatus(user: User) {
  try {
    await api.put(`/admin/users/${user.id}/status`, { is_active: !user.is_active });
    user.is_active = user.is_active ? 0 : 1;
    uiStore.showToast(user.is_active ? 'User enabled' : 'User disabled', 'success');
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to update status', 'error');
  }
}

async function createInviteCodes() {
  try {
    const body: Record<string, unknown> = { count: codeCount.value };
    if (codeExpiry.value) body.expires_in = parseInt(codeExpiry.value) * 3600;
    const data = await api.post<{ codes: string[] }>('/admin/invite-codes', body);
    createdCodes.value = data.codes;
    await loadData();
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to create codes', 'error');
  }
}

function copyCode(code: string) {
  navigator.clipboard.writeText(code);
  uiStore.showToast('Code copied', 'success');
}

function copyAllCodes() {
  navigator.clipboard.writeText(createdCodes.value.join('\n'));
  uiStore.showToast('All codes copied', 'success');
}

async function deleteCode(code: InviteCode) {
  try {
    await api.delete(`/admin/invite-codes/${code.id}`);
    inviteCodes.value = inviteCodes.value.filter((c) => c.id !== code.id);
    uiStore.showToast('Code deleted', 'success');
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to delete code', 'error');
  }
}

const unusedCodes = computed(() => inviteCodes.value.filter((c) => !c.is_used && !c.is_expired));
</script>

<template>
  <AppLayout>
    <div class="admin-view">
      <header class="page-header">
        <h1>Admin Panel</h1>
      </header>

      <div class="tabs">
        <button :class="{ active: activeTab === 'stats' }" @click="activeTab = 'stats'">Overview</button>
        <button :class="{ active: activeTab === 'users' }" @click="activeTab = 'users'">Users</button>
        <button :class="{ active: activeTab === 'invites' }" @click="activeTab = 'invites'">Invite Codes</button>
      </div>

      <div v-if="loading" class="loading">Loading...</div>

      <!-- Stats Tab -->
      <div v-else-if="activeTab === 'stats'" class="stats-grid">
        <div class="stat-card">
          <h3>Users</h3>
          <div class="stat-value">{{ stats?.users.total || 0 }}</div>
          <div class="stat-label">{{ stats?.users.active || 0 }} active</div>
        </div>
        <div class="stat-card">
          <h3>Files</h3>
          <div class="stat-value">{{ stats?.files.files || 0 }}</div>
          <div class="stat-label">{{ stats?.files.folders || 0 }} folders</div>
        </div>
        <div class="stat-card">
          <h3>Storage Used</h3>
          <div class="stat-value">{{ formatBytes(stats?.users.total_storage_used || 0) }}</div>
          <div class="stat-label">total across all users</div>
        </div>
        <div class="stat-card">
          <h3>Shared Links</h3>
          <div class="stat-value">{{ stats?.shares.total || 0 }}</div>
          <div class="stat-label">active share links</div>
        </div>
      </div>

      <!-- Users Tab -->
      <div v-else-if="activeTab === 'users'" class="users-list">
        <div v-for="user in users" :key="user.id" class="user-item">
          <div class="user-avatar">{{ user.username.charAt(0).toUpperCase() }}</div>
          <div class="user-info">
            <span class="user-name">
              {{ user.username }}
              <span v-if="user.role === 'admin'" class="role-badge">Admin</span>
            </span>
            <span class="user-email">{{ user.email }}</span>
          </div>
          <div class="user-storage">
            <div class="storage-text">
              {{ formatBytes(user.storage_used) }} / {{ formatBytes(user.storage_quota) }}
            </div>
            <div class="storage-bar">
              <div class="storage-fill" :style="{ width: `${Math.min((user.storage_used / user.storage_quota) * 100, 100)}%` }"></div>
            </div>
          </div>
          <div class="user-actions">
            <button class="btn-small" @click="openQuotaModal(user)">Set Quota</button>
            <button 
              v-if="user.role !== 'admin'" 
              class="btn-small" 
              :class="user.is_active ? 'btn-warning' : 'btn-success'"
              @click="toggleUserStatus(user)"
            >
              {{ user.is_active ? 'Disable' : 'Enable' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Invites Tab -->
      <div v-else-if="activeTab === 'invites'" class="invites-section">
        <div class="invites-header">
          <span>{{ unusedCodes.length }} unused codes</span>
          <button class="btn-primary" @click="showCreateCodeModal = true">Generate Codes</button>
        </div>
        
        <div class="invites-list">
          <div v-for="code in inviteCodes" :key="code.id" class="invite-item" :class="{ used: code.is_used, expired: code.is_expired }">
            <code class="invite-code">{{ code.code }}</code>
            <div class="invite-info">
              <span v-if="code.is_used">Used by {{ code.user_username }}</span>
              <span v-else-if="code.is_expired">Expired</span>
              <span v-else-if="code.expires_at">Expires {{ formatDate(code.expires_at) }}</span>
              <span v-else>No expiry</span>
            </div>
            <button v-if="!code.is_used" class="btn-icon-small" @click="copyCode(code.code)" title="Copy">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
            </button>
            <button v-if="!code.is_used" class="btn-icon-small danger" @click="deleteCode(code)" title="Delete">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Quota Modal -->
      <Teleport to="body">
        <div v-if="showQuotaModal" class="modal-overlay" @click="showQuotaModal = false">
          <div class="modal" @click.stop>
            <h3>Set Storage Quota</h3>
            <p>User: {{ selectedUser?.username }}</p>
            <div class="form-group">
              <label>Quota (GB)</label>
              <input v-model="newQuota" type="number" min="1" />
            </div>
            <div class="modal-actions">
              <button class="btn-secondary" @click="showQuotaModal = false">Cancel</button>
              <button class="btn-primary" @click="updateQuota">Save</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Create Codes Modal -->
      <Teleport to="body">
        <div v-if="showCreateCodeModal" class="modal-overlay" @click="showCreateCodeModal = false">
          <div class="modal" @click.stop>
            <h3>Generate Invite Codes</h3>
            <div v-if="createdCodes.length === 0">
              <div class="form-group">
                <label>Number of codes</label>
                <input v-model.number="codeCount" type="number" min="1" max="100" />
              </div>
              <div class="form-group">
                <label>Expiry (hours, optional)</label>
                <input v-model="codeExpiry" type="number" placeholder="Leave empty for no expiry" />
              </div>
              <div class="modal-actions">
                <button class="btn-secondary" @click="showCreateCodeModal = false">Cancel</button>
                <button class="btn-primary" @click="createInviteCodes">Generate</button>
              </div>
            </div>
            <div v-else class="created-codes">
              <div class="codes-list">
                <code v-for="code in createdCodes" :key="code">{{ code }}</code>
              </div>
              <div class="modal-actions">
                <button class="btn-primary" @click="copyAllCodes">Copy All</button>
                <button class="btn-secondary" @click="showCreateCodeModal = false; createdCodes = []">Close</button>
              </div>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
  </AppLayout>
</template>

<style scoped>
.admin-view {
  padding: 1.5rem;
}

.page-header h1 {
  font-size: 1.5rem;
  font-weight: 600;
  margin-bottom: 1rem;
}

.tabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

.tabs button {
  background: white;
  border: 1px solid #e5e7eb;
  padding: 0.625rem 1.25rem;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 500;
  color: #6b7280;
}

.tabs button.active {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border-color: transparent;
}

.loading {
  text-align: center;
  padding: 4rem;
  color: #9ca3af;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
}

.stat-card {
  background: white;
  border-radius: 12px;
  padding: 1.5rem;
}

.stat-card h3 {
  font-size: 0.875rem;
  color: #6b7280;
  margin: 0 0 0.5rem;
}

.stat-value {
  font-size: 2rem;
  font-weight: 700;
  color: #111827;
}

.stat-label {
  font-size: 0.75rem;
  color: #9ca3af;
}

.users-list, .invites-list {
  background: white;
  border-radius: 12px;
  overflow: hidden;
}

.user-item {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid #f3f4f6;
}

.user-avatar {
  width: 40px;
  height: 40px;
  background: linear-gradient(135deg, #667eea, #764ba2);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 600;
}

.user-info {
  flex: 1;
  min-width: 0;
}

.user-name {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 500;
}

.role-badge {
  font-size: 0.7rem;
  background: #dbeafe;
  color: #1d4ed8;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
}

.user-email {
  font-size: 0.875rem;
  color: #9ca3af;
  display: block;
}

.user-storage {
  width: 150px;
}

.storage-text {
  font-size: 0.75rem;
  color: #6b7280;
  margin-bottom: 0.25rem;
}

.storage-bar {
  height: 4px;
  background: #e5e7eb;
  border-radius: 2px;
  overflow: hidden;
}

.storage-fill {
  height: 100%;
  background: linear-gradient(90deg, #667eea, #764ba2);
}

.user-actions {
  display: flex;
  gap: 0.5rem;
}

.btn-small {
  padding: 0.375rem 0.75rem;
  font-size: 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  background: white;
  border: 1px solid #e5e7eb;
  color: #374151;
}

.btn-small.btn-warning {
  color: #d97706;
  border-color: #d97706;
}

.btn-small.btn-success {
  color: #10b981;
  border-color: #10b981;
}

.invites-section {
  background: white;
  border-radius: 12px;
  padding: 1.5rem;
}

.invites-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.invite-item {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid #f3f4f6;
}

.invite-item.used, .invite-item.expired {
  opacity: 0.5;
}

.invite-code {
  font-family: monospace;
  font-size: 1rem;
  background: #f3f4f6;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
}

.invite-info {
  flex: 1;
  font-size: 0.875rem;
  color: #6b7280;
}

.btn-icon-small {
  background: none;
  border: none;
  padding: 0.375rem;
  cursor: pointer;
  color: #6b7280;
  border-radius: 4px;
}

.btn-icon-small:hover {
  background: #f3f4f6;
}

.btn-icon-small.danger:hover {
  color: #ef4444;
}

.btn-primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  padding: 0.625rem 1.25rem;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
}

.btn-secondary {
  background: white;
  color: #374151;
  border: 1px solid #e5e7eb;
  padding: 0.625rem 1.25rem;
  border-radius: 8px;
  cursor: pointer;
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
  margin-bottom: 1rem;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.5rem;
}

.form-group input {
  width: 100%;
  padding: 0.625rem;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
}

.modal-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}

.created-codes .codes-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
  max-height: 200px;
  overflow-y: auto;
}

.created-codes code {
  font-family: monospace;
  background: #f3f4f6;
  padding: 0.5rem;
  border-radius: 4px;
}
</style>
