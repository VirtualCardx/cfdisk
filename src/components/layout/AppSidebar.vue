<script setup lang="ts">
import { computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const uiStore = useUIStore();

const currentPage = computed(() => {
  if (route.name === 'trash') return 'trash';
  if (route.name === 'shares') return 'shares';
  if (route.name === 'admin') return 'admin';
  return 'drive';
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

async function handleLogout() {
  await authStore.logout();
  router.push('/login');
}

function openChangePassword() {
  uiStore.openModal('changePassword');
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed: !uiStore.sidebarOpen }">
    <div class="sidebar-header">
      <h1 class="logo">CFDisk</h1>
      <button class="toggle-btn" @click="uiStore.toggleSidebar">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12h18M3 6h18M3 18h18"/>
        </svg>
      </button>
    </div>

    <nav class="sidebar-nav">
      <router-link to="/drive" class="nav-item" :class="{ active: currentPage === 'drive' }">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
        </svg>
        <span>My Files</span>
      </router-link>

      <router-link to="/drive/trash" class="nav-item" :class="{ active: currentPage === 'trash' }">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
        </svg>
        <span>Trash</span>
      </router-link>

      <router-link to="/drive/shares" class="nav-item" :class="{ active: currentPage === 'shares' }">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13"/>
        </svg>
        <span>Shared Links</span>
      </router-link>

      <router-link v-if="authStore.isAdmin" to="/admin" class="nav-item" :class="{ active: currentPage === 'admin' }">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
        <span>Admin</span>
      </router-link>

      <!-- 移动端底栏没有侧边栏页脚，把「改密码 / 退出」单独放出来，功能与桌面端对齐 -->
      <button class="nav-item mobile-only" @click="openChangePassword">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="11" width="16" height="10" rx="2"/>
          <path d="M8 11V7a4 4 0 118 0v4"/>
        </svg>
        <span>Account</span>
      </button>

      <button class="nav-item mobile-only" @click="handleLogout">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
        </svg>
        <span>Logout</span>
      </button>
    </nav>

    <div class="sidebar-footer">
      <div class="storage-info">
        <div class="storage-label">
          <span>Storage</span>
          <span>{{ authStore.storagePercent }}%</span>
        </div>
        <div class="storage-bar">
          <div class="storage-fill" :style="{ width: `${authStore.storagePercent}%` }"></div>
        </div>
        <div class="storage-text">
          {{ formatBytes(authStore.user?.storage_used || 0) }} / {{ formatBytes(authStore.user?.storage_quota || 0) }}
        </div>
      </div>

      <div class="user-info">
        <div class="user-avatar">{{ authStore.user?.username.charAt(0).toUpperCase() }}</div>
        <div class="user-details">
          <span class="user-name">{{ authStore.user?.username }}</span>
          <span class="user-role">{{ authStore.user?.role }}</span>
        </div>
        <button class="logout-btn" @click="openChangePassword" title="Change password">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="4" y="11" width="16" height="10" rx="2"/>
            <path d="M8 11V7a4 4 0 118 0v4"/>
          </svg>
        </button>
        <button class="logout-btn" @click="handleLogout" title="Logout">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
          </svg>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 260px;
  height: 100vh;
  background: #0f172a;
  color: #e5e5e5;
  display: flex;
  flex-direction: column;
  transition: width 0.3s ease;
  position: fixed;
  left: 0;
  top: 0;
  z-index: 100;
}

.sidebar.collapsed {
  width: 60px;
}

.sidebar.collapsed .logo,
.sidebar.collapsed .nav-item span,
.sidebar.collapsed .storage-info,
.sidebar.collapsed .user-details {
  display: none;
}

/*
 * 折叠态的页脚要跟着一起收窄。
 *
 * 桌面布局是「头像 + 用户名 + 两个图标按钮」横排（头像 36px、间距 12px、按钮约 34px），
 * 一行下来接近 200px；侧边栏收到 60px 后这行放不下，又没有 overflow 裁剪，
 * 头像和按钮就溢出到侧边栏之外、压在内容区上。
 * 折叠时改成纵向堆叠：头像居中，两个图标按钮排在下方。
 */
.sidebar.collapsed .sidebar-footer {
  padding: 0.75rem 0.5rem;
}

/* 折叠时图标占据全部可用宽度并居中，避免 1rem 的左右内边距把图标顶偏 */
.sidebar.collapsed .nav-item {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
}

.sidebar.collapsed .user-info {
  flex-direction: column;
  gap: 0.375rem;
}

.sidebar.collapsed .user-avatar {
  width: 32px;
  height: 32px;
  font-size: 0.8125rem;
}

.sidebar.collapsed .logout-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.375rem 0;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem;
  border-bottom: 1px solid #1e3a8a;
}

.logo {
  font-size: 1.5rem;
  font-weight: 700;
  color: #3b82f6;
}

.toggle-btn {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 0.5rem;
  border-radius: 8px;
  transition: background 0.2s;
}

.toggle-btn:hover {
  background: #1e3a8a;
  color: #fff;
}

.sidebar-nav {
  flex: 1;
  padding: 1rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  color: #94a3b8;
  text-decoration: none;
  border-radius: 8px;
  transition: all 0.2s;
}

.nav-item:hover {
  background: #1e3a8a;
  color: #fff;
}

.nav-item.active {
  background: #1e40af;
  color: #fff;
}

/* 移动端专用入口，桌面端隐藏 */
.nav-item.mobile-only {
  display: none;
}

button.nav-item {
  background: none;
  border: none;
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
  text-align: left;
  width: 100%;
}

.sidebar-footer {
  padding: 1rem;
  border-top: 1px solid #1e3a8a;
}

.storage-info {
  margin-bottom: 1rem;
}

.storage-label {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: #94a3b8;
  margin-bottom: 0.5rem;
}

.storage-bar {
  height: 4px;
  background: #1e3a8a;
  border-radius: 2px;
  overflow: hidden;
}

.storage-fill {
  height: 100%;
  background: #3b82f6;
  border-radius: 2px;
  transition: width 0.3s;
}

.storage-text {
  font-size: 0.7rem;
  color: #64748b;
  margin-top: 0.25rem;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.user-avatar {
  width: 36px;
  height: 36px;
  background: #1e40af;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  flex-shrink: 0;
}

.user-details {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.user-name {
  font-weight: 500;
  font-size: 0.875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user-role {
  font-size: 0.75rem;
  color: #64748b;
  text-transform: capitalize;
}

.logout-btn {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 0.5rem;
  border-radius: 8px;
  transition: all 0.2s;
}

.logout-btn:hover {
  background: #1e3a8a;
  color: #fff;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .sidebar {
    width: 100%;
    height: 60px;
    flex-direction: row;
    top: auto;
    bottom: 0;
    left: 0;
    border-top: 1px solid #1e3a8a;
    padding-bottom: env(safe-area-inset-bottom, 0);
  }

  .sidebar.collapsed {
    width: 100%;
  }

  .sidebar-header {
    display: none;
  }

  .sidebar-nav {
    flex-direction: row;
    justify-content: space-around;
    align-items: stretch;
    gap: 0;
    padding: 0.25rem;
    flex: 1;
  }

  /*
   * 每个入口平分宽度。
   *
   * 之前 `button.nav-item` 带着桌面端的 `width: 100%`，在横排 flex 里会吃掉全部剩余空间：
   * 前面几个链接被压成 36px 挤在左边，最后一个按钮又把图标居中顶到最右，
   * 看起来就是「中间空一大块、按钮没排开」。
   * 用 `flex: 1 1 0` + `width: auto` 让每个入口等宽，图标才会均匀分布。
   */
  .nav-item {
    flex: 1 1 0;
    width: auto;
    min-width: 0;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    padding: 0.375rem 0.25rem;
    gap: 0.25rem;
    font-size: 0.7rem;
  }

  .nav-item span {
    font-size: 0.65rem;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nav-item.mobile-only {
    display: flex;
  }

  .sidebar-footer {
    display: none;
  }
}

@media (max-width: 480px) {
  .nav-item span {
    display: none;
  }

  .nav-item {
    padding: 0.5rem;
  }
}
</style>
