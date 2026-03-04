import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { FileItem } from './files';

export type ModalType =
  | 'rename'
  | 'newFolder'
  | 'delete'
  | 'move'
  | 'share'
  | 'preview'
  | 'changePassword';

export const useUIStore = defineStore('ui', () => {
  const activeModal = ref<ModalType | null>(null);
  const modalData = ref<unknown>(null);
  const sidebarOpen = ref(true);
  const contextMenu = ref<{ x: number; y: number; file: FileItem } | null>(null);
  const toast = ref<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  function openModal(type: ModalType, data?: unknown): void {
    activeModal.value = type;
    modalData.value = data ?? null;
  }

  function closeModal(): void {
    activeModal.value = null;
    modalData.value = null;
  }

  function toggleSidebar(): void {
    sidebarOpen.value = !sidebarOpen.value;
  }

  function showContextMenu(x: number, y: number, file: FileItem): void {
    contextMenu.value = { x, y, file };
  }

  function hideContextMenu(): void {
    contextMenu.value = null;
  }

  function showToast(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
    toast.value = { message, type };
    setTimeout(() => {
      toast.value = null;
    }, 3000);
  }

  return {
    activeModal,
    modalData,
    sidebarOpen,
    contextMenu,
    toast,
    openModal,
    closeModal,
    toggleSidebar,
    showContextMenu,
    hideContextMenu,
    showToast,
  };
});
