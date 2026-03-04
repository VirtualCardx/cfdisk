import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useFilesStore, type FileItem } from './files';
import { useAuthStore } from './auth';

export interface UploadTask {
  id: string;
  file: File;
  parentId: string | null;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  error?: string;
}

export const useUploadStore = defineStore('upload', () => {
  const queue = ref<UploadTask[]>([]);
  const isUploading = ref(false);

  const totalProgress = computed(() => {
    if (queue.value.length === 0) return 0;
    const total = queue.value.reduce((sum, task) => sum + task.progress, 0);
    return Math.round(total / queue.value.length);
  });

  const activeUploads = computed(() => queue.value.filter((t) => t.status === 'uploading').length);

  const pendingUploads = computed(() => queue.value.filter((t) => t.status === 'pending').length);

  function addToQueue(files: FileList | File[], parentId: string | null): void {
    const newTasks: UploadTask[] = Array.from(files).map((file) => ({
      id: crypto.randomUUID(),
      file,
      parentId,
      progress: 0,
      status: 'pending',
    }));
    queue.value.push(...newTasks);

    if (!isUploading.value) {
      processQueue();
    }
  }

  async function processQueue(): Promise<void> {
    if (isUploading.value) return;

    const pendingTask = queue.value.find((t) => t.status === 'pending');
    if (!pendingTask) {
      isUploading.value = false;
      return;
    }

    isUploading.value = true;
    pendingTask.status = 'uploading';

    try {
      await uploadFile(pendingTask);
      pendingTask.status = 'completed';
      pendingTask.progress = 100;
    } catch (e) {
      pendingTask.status = 'error';
      pendingTask.error = e instanceof Error ? e.message : 'Upload failed';
    }

    isUploading.value = false;
    processQueue();
  }

  async function uploadFile(task: UploadTask): Promise<void> {
    const filesStore = useFilesStore();
    const authStore = useAuthStore();

    const formData = new FormData();
    formData.append('file', task.file);
    if (task.parentId) {
      formData.append('parent_id', task.parentId);
    }

    const xhr = new XMLHttpRequest();

    return new Promise((resolve, reject) => {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          task.progress = Math.round((e.loaded / e.total) * 100);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            if (response.success && response.data?.file) {
              if (task.parentId === filesStore.currentFolderId) {
                filesStore.files.push(response.data.file as FileItem);
              }
              authStore.updateStorageUsed(task.file.size);
            }
            resolve();
          } catch {
            reject(new Error('Invalid response'));
          }
        } else {
          try {
            const response = JSON.parse(xhr.responseText);
            reject(new Error(response.error?.message || 'Upload failed'));
          } catch {
            reject(new Error('Upload failed'));
          }
        }
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Network error'));
      });

      xhr.open('POST', '/api/files/upload');
      const token = localStorage.getItem('token');
      if (token) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }
      xhr.send(formData);
    });
  }

  function removeTask(taskId: string): void {
    queue.value = queue.value.filter((t) => t.id !== taskId);
  }

  function clearCompleted(): void {
    queue.value = queue.value.filter((t) => t.status !== 'completed');
  }

  function retryTask(taskId: string): void {
    const task = queue.value.find((t) => t.id === taskId);
    if (task && task.status === 'error') {
      task.status = 'pending';
      task.progress = 0;
      task.error = undefined;
      processQueue();
    }
  }

  return {
    queue,
    isUploading,
    totalProgress,
    activeUploads,
    pendingUploads,
    addToQueue,
    processQueue,
    removeTask,
    clearCompleted,
    retryTask,
  };
});
