import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useFilesStore, type FileItem } from './files';
import { useAuthStore } from './auth';
import { uploadFileChunked, shouldUseChunkedUpload } from '@/utils/uploadChunked';
import { createThumbnail, isThumbnailableImage, uploadThumbnail } from '@/utils/thumbnail';

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

  /**
   * 缩略图作业状态，供 FileThumb 判断「这张图是刚传的，别去下载原图回填」。
   * 上传时原图就在内存里，直接生成缩略图即可；只有历史文件才需要下载原图补生成。
   */
  const pendingThumbs = ref<Set<string>>(new Set());
  const thumbAttempted = ref<Set<string>>(new Set());

  const totalProgress = computed(() => {
    if (queue.value.length === 0) return 0;
    const total = queue.value.reduce((sum, task) => sum + task.progress, 0);
    return Math.round(total / queue.value.length);
  });

  const activeUploads = computed(() => queue.value.filter((t) => t.status === 'uploading').length);

  /** 有任务在飞即视为「正在上传」 */
  const isUploading = computed(() => activeUploads.value > 0);

  const pendingUploads = computed(() => queue.value.filter((t) => t.status === 'pending').length);

  /**
   * 同时进行的上传任务数。
   *
   * 之前是严格串行：一个任务传完才轮到下一个，选 20 张小图上传的总耗时
   * 等于 20 个请求的耗时之和。浏览器对同一域名允许 6 个并发连接，
   * 这里用 3 个槽位跑文件、剩下留给列表刷新和缩略图，互不抢占。
   */
  const MAX_CONCURRENT_UPLOADS = 3;

  /**
   * 批量上传的文件数目统计，供进度面板显示「总共 / 已上传 / 剩余」。
   *
   * remaining 只算「还没处理完的」（排队 + 正在传），失败项单独计数，
   * 这样 total = completed + remaining + failed 恒等，用户不会看到
   * 「12 个文件，5 个完成，7 个剩余，1 个失败」这种加起来超额的显示。
   *
   * percent 把失败项也按「已处理」计入：否则某个文件传到 40% 失败后，
   * 整体进度会永远停在 9x%，看起来像卡死。失败信息由 failed 数字表达。
   */
  const stats = computed(() => {
    let completed = 0;
    let failed = 0;
    let uploading = 0;
    let pending = 0;
    let processed = 0;

    for (const task of queue.value) {
      if (task.status === 'completed') {
        completed += 1;
        processed += 100;
      } else if (task.status === 'error') {
        failed += 1;
        processed += 100;
      } else {
        if (task.status === 'uploading') uploading += 1;
        else pending += 1;
        processed += task.progress;
      }
    }

    const total = queue.value.length;
    return {
      total,
      completed,
      failed,
      uploading,
      pending,
      remaining: uploading + pending,
      percent: total === 0 ? 0 : Math.round(processed / total),
    };
  });

  const isBatch = computed(() => queue.value.length > 1);

  function addToQueue(files: FileList | File[], parentId: string | null): void {
    const newTasks: UploadTask[] = Array.from(files).map((file) => ({
      id: crypto.randomUUID(),
      file,
      parentId,
      progress: 0,
      status: 'pending',
    }));
    queue.value.push(...newTasks);
    pump();
  }

  /**
   * 把空闲的并发槽位填满。
   *
   * 状态在同步阶段就切成 uploading，所以 while 循环里不会再选中同一个任务；
   * 任务结束后再次调用本函数领取下一个，整体行为等价于固定大小的任务池。
   */
  function pump(): void {
    while (activeUploads.value < MAX_CONCURRENT_UPLOADS) {
      const next = queue.value.find((t) => t.status === 'pending');
      if (!next) return;

      next.status = 'uploading';
      next.progress = 0;
      void runTask(next);
    }
  }

  async function runTask(task: UploadTask): Promise<void> {
    try {
      await uploadFile(task);
      task.status = 'completed';
      task.progress = 100;
    } catch (e) {
      task.status = 'error';
      task.error = e instanceof Error ? e.message : 'Upload failed';
    }

    // 单个任务失败不影响其它任务，继续领取下一个
    pump();
  }

  async function uploadFile(task: UploadTask): Promise<void> {
    const filesStore = useFilesStore();
    const authStore = useAuthStore();

    // 大文件使用分片上传
    if (shouldUseChunkedUpload(task.file.size)) {
      const result = await uploadFileChunked({
        file: task.file,
        parentId: task.parentId,
        onProgress: (progress) => {
          task.progress = progress;
        },
      });

      if (result.success && result.file) {
        if (task.parentId === filesStore.currentFolderId) {
          filesStore.files.push(result.file as FileItem);
        }
        authStore.updateStorageUsed(task.file.size);
        void attachThumbnail(task.file, result.file.id);
        return;
      } else {
        throw new Error(result.error || 'Upload failed');
      }
    }

    // 小文件使用普通上传
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
              void attachThumbnail(task.file, response.data.file.id);
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

  /**
   * 上传成功后立即用内存里的原图生成缩略图并回传。
   *
   * 这条路径不需要再下载原图（字节本来就在手上），因此新上传的图片
   * 无论多大都能有缩略图；失败也不影响上传结果，只是列表里退回图标。
   */
  async function attachThumbnail(file: File, fileId: string): Promise<void> {
    if (!isThumbnailableImage(file.type)) return;

    const filesStore = useFilesStore();

    pendingThumbs.value.add(fileId);
    thumbAttempted.value.add(fileId);

    try {
      const thumb = await createThumbnail(file);
      if (!thumb) return;

      const url = await uploadThumbnail(fileId, thumb);
      if (url) filesStore.setThumbUrl(fileId, url);
    } catch {
      /* 缩略图是锦上添花，任何异常都吞掉 */
    } finally {
      pendingThumbs.value.delete(fileId);
    }
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
      pump();
    }
  }

  return {
    queue,
    isUploading,
    pendingThumbs,
    thumbAttempted,
    totalProgress,
    activeUploads,
    pendingUploads,
    stats,
    isBatch,
    addToQueue,
    pump,
    removeTask,
    clearCompleted,
    retryTask,
  };
});
