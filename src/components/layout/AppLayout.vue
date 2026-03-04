<script setup lang="ts">
import { useUIStore } from '@/stores/ui';
import AppSidebar from './AppSidebar.vue';

const uiStore = useUIStore();
</script>

<template>
  <div class="app-layout">
    <AppSidebar />
    <main class="main-content" :class="{ expanded: !uiStore.sidebarOpen }">
      <slot />
    </main>

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
  background: #f5f7fa;
}

.main-content {
  margin-left: 260px;
  min-height: 100vh;
  transition: margin-left 0.3s ease;
}

.main-content.expanded {
  margin-left: 60px;
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
}

.toast.success {
  background: #10b981;
  color: white;
}

.toast.error {
  background: #ef4444;
  color: white;
}

.toast.info {
  background: #3b82f6;
  color: white;
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
