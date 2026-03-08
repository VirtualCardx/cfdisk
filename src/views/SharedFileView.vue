<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '@/api/client';

interface ShareInfo {
  file_name: string;
  file_type: string;
  mime_type: string;
  size: number;
  needs_password: boolean;
  expires_at: number | null;
}

const route = useRoute();
const token = computed(() => route.params.token as string);

const shareInfo = ref<ShareInfo | null>(null);
const loading = ref(true);
const error = ref('');
const password = ref('');
const passwordVerified = ref(false);
const passwordError = ref('');
const downloadProgress = ref(0);
const isDownloading = ref(false);

onMounted(() => {
  loadShareInfo();
});

async function loadShareInfo() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.get<{ share: ShareInfo }>(`/s/${token.value}`, { skipAuth: true });
    shareInfo.value = data.share;
    if (!data.share.needs_password) {
      passwordVerified.value = true;
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Failed to load share';
  } finally {
    loading.value = false;
  }
}

async function verifyPassword() {
  passwordError.value = '';
  try {
    await api.post(`/s/${token.value}/verify`, { password: password.value }, { skipAuth: true });
    passwordVerified.value = true;
  } catch (e: unknown) {
    passwordError.value = e instanceof Error ? e.message : 'Incorrect password';
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function isImage(mimeType: string): boolean {
  return mimeType?.startsWith('image/');
}

function isVideo(mimeType: string): boolean {
  return mimeType?.startsWith('video/');
}

function isAudio(mimeType: string): boolean {
  return mimeType?.startsWith('audio/');
}

function getPreviewUrl(): string {
  const base = `/api/s/${token.value}/preview`;
  return passwordVerified.value ? `${base}?verified=true` : base;
}

function getDownloadUrl(): string {
  const base = `/api/s/${token.value}/download`;
  return passwordVerified.value ? `${base}?verified=true` : base;
}

async function download() {
  try {
    error.value = '';
    isDownloading.value = true;
    downloadProgress.value = 0;
    
    const response = await fetch(getDownloadUrl(), {
      method: 'GET',
      credentials: 'same-origin'
    });
    
    if (!response.ok) {
      const contentType = response.headers.get('Content-Type');
      let errorMessage = 'Download failed';
      
      if (contentType?.includes('application/json')) {
        const errorData = await response.json().catch(() => ({ message: 'Download failed' }));
        errorMessage = errorData.message || errorMessage;
      } else {
        errorMessage = `Download failed: ${response.status} ${response.statusText}`;
      }
      
      throw new Error(errorMessage);
    }
    
    // 获取文件总大小
    const contentLength = response.headers.get('Content-Length');
    const totalSize = contentLength ? parseInt(contentLength, 10) : 0;
    
    if (!response.body) {
      throw new Error('No response body');
    }
    
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedSize = 0;
    
    // 读取数据流并更新进度
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        break;
      }
      
      chunks.push(value);
      receivedSize += value.length;
      
      if (totalSize > 0) {
        downloadProgress.value = Math.round((receivedSize / totalSize) * 100);
      }
    }
    
    // 合并所有 chunks
    const allChunks = new Uint8Array(receivedSize);
    let position = 0;
    for (const chunk of chunks) {
      allChunks.set(chunk, position);
      position += chunk.length;
    }
    
    const blob = new Blob([allChunks]);
    
    if (blob.size === 0) {
      throw new Error('Downloaded file is empty');
    }
    
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = shareInfo.value?.file_name || 'download';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    
    // 延迟清理，确保下载开始
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    
    downloadProgress.value = 100;
    
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Failed to download file';
    console.error('Download error:', e);
  } finally {
    isDownloading.value = false;
  }
}
</script>

<template>
  <div class="shared-view">
    <div class="shared-card">
      <div class="logo">CFDisk</div>

      <div v-if="loading" class="loading">Loading...</div>

      <div v-else-if="error" class="error-state">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <p>{{ error }}</p>
      </div>

      <div v-else-if="shareInfo && !passwordVerified" class="password-form">
        <h2>This file is password protected</h2>
        <p class="file-name">{{ shareInfo.file_name }}</p>
        <form @submit.prevent="verifyPassword">
          <input v-model="password" type="password" placeholder="Enter password" required />
          <div v-if="passwordError" class="password-error">{{ passwordError }}</div>
          <button type="submit" class="btn-primary">Unlock</button>
        </form>
      </div>

      <div v-else-if="shareInfo && passwordVerified" class="file-preview">
        <h2>{{ shareInfo.file_name }}</h2>
        <p class="file-meta">{{ formatBytes(shareInfo.size) }}</p>

        <div class="preview-area">
          <img v-if="isImage(shareInfo.mime_type)" :src="getPreviewUrl()" :alt="shareInfo.file_name" />
          <video v-else-if="isVideo(shareInfo.mime_type)" :src="getPreviewUrl()" controls />
          <audio v-else-if="isAudio(shareInfo.mime_type)" :src="getPreviewUrl()" controls />
          <div v-else class="no-preview">
            <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
            </svg>
            <p>Preview not available</p>
          </div>
        </div>

        <button class="btn-primary download-btn" @click="download" :disabled="isDownloading">
          <svg v-if="!isDownloading" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
          </svg>
          <svg v-else class="spinner" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"/>
          </svg>
          {{ isDownloading ? '下载中...' : '下载文件' }}
        </button>
        
        <!-- 下载进度条 -->
        <div v-if="isDownloading" class="download-progress-container">
          <div class="download-progress-bar">
            <div class="download-progress-fill" :style="{ width: `${downloadProgress}%` }"></div>
          </div>
          <div class="download-progress-text">{{ downloadProgress }}%</div>
        </div>
        <div v-else-if="downloadProgress === 100" class="download-success">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          下载完成
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shared-view {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0f172a;
  padding: 1rem;
}

.shared-card {
  background: #fff;
  border-radius: 16px;
  padding: 2rem;
  width: 100%;
  max-width: 600px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.logo {
  font-size: 1.5rem;
  font-weight: 700;
  text-align: center;
  margin-bottom: 1.5rem;
  color: #1e40af;
}

.loading {
  text-align: center;
  padding: 3rem;
  color: #94a3b8;
}

.error-state {
  text-align: center;
  padding: 2rem;
  color: #dc2626;
}

.error-state svg {
  margin-bottom: 1rem;
}

.password-form {
  text-align: center;
}

.password-form h2 {
  font-size: 1.25rem;
  margin-bottom: 0.5rem;
}

.password-form .file-name {
  color: #64748b;
  margin-bottom: 1.5rem;
  word-break: break-all;
}

.password-form input {
  width: 100%;
  padding: 0.875rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 1rem;
  margin-bottom: 1rem;
}

.password-error {
  color: #dc2626;
  font-size: 0.875rem;
  margin-bottom: 1rem;
}

.file-preview h2 {
  font-size: 1.25rem;
  text-align: center;
  margin-bottom: 0.25rem;
  word-break: break-all;
}

.file-meta {
  text-align: center;
  color: #94a3b8;
  margin-bottom: 1.5rem;
}

.preview-area {
  background: #f1f5f9;
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 1.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}

.preview-area img {
  max-width: 100%;
  max-height: 400px;
  display: block;
}

.preview-area video, .preview-area audio {
  width: 100%;
  max-height: 400px;
}

.no-preview {
  text-align: center;
  padding: 3rem;
  color: #94a3b8;
}

.no-preview svg {
  margin-bottom: 1rem;
}

.btn-primary {
  background: #1e40af;
  color: #fff;
  border: none;
  padding: 0.875rem 1.5rem;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  transition: background 0.2s;
}

.btn-primary:hover:not(:disabled) {
  background: #1e3a8a;
}

.btn-primary:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.download-progress-container {
  margin-top: 1rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.download-progress-bar {
  flex: 1;
  height: 8px;
  background: #e2e8f0;
  border-radius: 4px;
  overflow: hidden;
}

.download-progress-fill {
  height: 100%;
  background: #3b82f6;
  border-radius: 4px;
  transition: width 0.3s ease;
}

.download-progress-text {
  font-size: 0.875rem;
  font-weight: 500;
  color: #3b82f6;
  min-width: 40px;
  text-align: right;
}

.download-success {
  margin-top: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  color: #22c55e;
  font-size: 0.875rem;
  font-weight: 500;
}
</style>
