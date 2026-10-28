<script setup lang="ts">
import { useUIStore } from '@/stores/ui';
import AppSidebar from './AppSidebar.vue';
import PreviewModal from '@/components/preview/PreviewModal.vue';
import ChangePasswordModal from '@/components/settings/ChangePasswordModal.vue';

const uiStore = useUIStore();
</script>

<template>
  <div class="app-layout">
    <AppSidebar />
    <main class="main-content" :class="{ expanded: !uiStore.sidebarOpen }">
      <slot />
    </main>

    <PreviewModal />
    <ChangePasswordModal />

    <Teleport to="body">
      <div v-if="uiStore.toast" class="toast" :class="uiStore.toast.type">
        {{ uiStore.toast.message }}
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.app-layout {
  min-height: 100vh;
  background: #f1f5f9;
}

.main-content {
  margin-left: 260px;
  min-height: 100vh;
  transition: margin-left 0.3s ease;
}

.main-content.expanded {
  margin-left: 60px;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .main-content {
    margin-left: 0;
    /* 底部导航 60px + 呼吸空间，外加 iPhone 类机型的 home indicator 安全区 */
    padding-bottom: calc(70px + env(safe-area-inset-bottom, 0px));
  }

  .main-content.expanded {
    margin-left: 0;
  }
}

.toast {
  position: fixed;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 0.875rem 1.5rem;
  border-radius: 8px;
  font-weight: 500;
  z-index: 1000;
  animation: slideUp 0.3s ease;
  max-width: 90vw;
  word-break: break-word;
}

@media (max-width: 768px) {
  .toast {
    bottom: 5rem; /* 在底部导航栏上方显示 */
    font-size: 0.875rem;
    padding: 0.75rem 1rem;
  }
}

.toast.success {
  background: #1e40af;
  color: #fff;
}

.toast.error {
  background: #0f172a;
  color: #fff;
}

.toast.info {
  background: #3b82f6;
  color: #fff;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}
</style>
