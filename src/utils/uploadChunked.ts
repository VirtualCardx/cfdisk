/**
 * 分片上传工具
 * 将大文件分割成小块上传，避免 HTTP/2 超时问题
 */

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB 每片
const MAX_RETRIES = 3; // 每片最大重试次数
const RETRY_DELAY = 1000; // 重试间隔（毫秒）

export interface ChunkedUploadOptions {
  file: File;
  parentId: string | null;
  onProgress: (progress: number) => void;
  onChunkComplete?: (chunkIndex: number, totalChunks: number) => void;
}

export interface ChunkedUploadResult {
  success: boolean;
  file?: {
    id: string;
    parent_id: string | null;
    name: string;
    type: string;
    size: number;
    mime_type: string;
    created_at: number;
    updated_at: number;
  };
  error?: string;
}

/**
 * 生成文件唯一标识
 */
function generateFileHash(file: File): Promise<string> {
  return new Promise((resolve) => {
    // 使用文件名+大小+修改时间作为简单标识
    const str = `${file.name}-${file.size}-${file.lastModified}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    resolve(Math.abs(hash).toString(16));
  });
}

/**
 * 上传单个分片
 */
async function uploadChunk(
  chunk: Blob,
  chunkIndex: number,
  totalChunks: number,
  fileHash: string,
  fileName: string,
  parentId: string | null,
  token: string | null
): Promise<{ success: boolean; file?: { id: string; name: string; type: string; mime_type: string; size: number; created_at: number; updated_at: number }; error?: string }> {
  const formData = new FormData();
  formData.append('chunk', chunk);
  formData.append('chunkIndex', chunkIndex.toString());
  formData.append('totalChunks', totalChunks.toString());
  formData.append('fileHash', fileHash);
  formData.append('fileName', fileName);
  formData.append('fileSize', chunk.size.toString());
  if (parentId) {
    formData.append('parent_id', parentId);
  }

  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch('/api/files/upload-chunk', {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { success: false, error: errorText || `HTTP ${response.status}` };
  }

  const result = await response.json();
  // 如果是最后一片，返回包含 file 的完整结果
  if (result.file) {
    return { success: result.success, file: result.file };
  }
  return { success: result.success, error: result.error?.message };
}

/**
 * 带重试机制的分片上传
 */
async function uploadChunkWithRetry(
  chunk: Blob,
  chunkIndex: number,
  totalChunks: number,
  fileHash: string,
  fileName: string,
  parentId: string | null,
  token: string | null
): Promise<{ success: boolean; file?: { id: string; name: string; type: string; mime_type: string; size: number; created_at: number; updated_at: number }; error?: string }> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await uploadChunk(
        chunk,
        chunkIndex,
        totalChunks,
        fileHash,
        fileName,
        parentId,
        token
      );
      
      if (result.success) {
        return result;
      }
      
      // 如果是最后一片且合并失败，直接返回错误
      if (chunkIndex === totalChunks - 1) {
        return result;
      }
      
      // 其他情况重试
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
      }
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        return { 
          success: false, 
          error: error instanceof Error ? error.message : 'Upload failed' 
        };
      }
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
    }
  }
  
  return { success: false, error: 'Max retries exceeded' };
}

/**
 * 执行分片上传
 */
export async function uploadFileChunked(
  options: ChunkedUploadOptions
): Promise<ChunkedUploadResult> {
  const { file, parentId, onProgress, onChunkComplete } = options;
  
  // 小文件直接返回，使用普通上传
  if (file.size <= CHUNK_SIZE) {
    return { success: false, error: 'Use regular upload for small files' };
  }

  const token = localStorage.getItem('token');
  const fileHash = await generateFileHash(file);
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  
  let uploadedChunks = 0;

  try {
    let lastResult: { success: boolean; file?: { id: string; name: string; type: string; mime_type: string; size: number; created_at: number; updated_at: number }; error?: string } | null = null;
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      const result = await uploadChunkWithRetry(
        chunk,
        i,
        totalChunks,
        fileHash,
        file.name,
        parentId,
        token
      );

      if (!result.success) {
        return { success: false, error: result.error || `Chunk ${i + 1} failed` };
      }

      lastResult = result;
      uploadedChunks++;
      const progress = Math.round((uploadedChunks / totalChunks) * 100);
      onProgress(progress);
      
      if (onChunkComplete) {
        onChunkComplete(i + 1, totalChunks);
      }
    }

    // 所有分片上传完成，返回服务器返回的文件信息
    // 最后一片上传会返回完整的文件对象
    if (lastResult?.file) {
      return { 
        success: true,
        file: {
          ...lastResult.file,
          parent_id: parentId
        }
      };
    }
    
    return { success: false, error: 'No file data returned from server' };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Upload failed' 
    };
  }
}

/**
 * 检查是否应该使用分片上传
 */
export function shouldUseChunkedUpload(fileSize: number): boolean {
  return fileSize > CHUNK_SIZE; // 大于 5MB 使用分片上传
}
