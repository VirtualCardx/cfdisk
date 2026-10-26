/**
 * 分片上传工具
 *
 * 顺序很关键：服务端约定「首片建会话、末片合并」，所以这里先单独发第 0 片，
 * 中间分片按 3 路并发上传，最后单独发第 n-1 片触发合并并拿到文件对象。
 * 每个上传会话带独立 sessionId，同名同大小文件并发上传不会互相污染状态。
 */

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB 每片
const CHUNK_CONCURRENCY = 3; // 中间分片并发数
const MAX_RETRIES = 3; // 每片最大重试次数
const RETRY_DELAY = 1000; // 重试间隔（毫秒）

interface ChunkResult {
  success: boolean;
  file?: {
    id: string;
    name: string;
    type: string;
    mime_type: string;
    size: number;
    created_at: number;
    updated_at: number;
  };
  error?: string;
}

export interface ChunkedUploadOptions {
  file: File;
  parentId: string | null;
  onProgress: (progress: number) => void;
  onChunkComplete?: (completedChunks: number, totalChunks: number) => void;
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
 * 上传单个分片
 */
async function uploadChunk(
  chunk: Blob,
  chunkIndex: number,
  totalChunks: number,
  fileName: string,
  fileSize: number,
  parentId: string | null,
  sessionId: string,
  token: string | null
): Promise<ChunkResult> {
  const formData = new FormData();
  formData.append('chunk', chunk);
  formData.append('chunkIndex', chunkIndex.toString());
  formData.append('totalChunks', totalChunks.toString());
  formData.append('sessionId', sessionId);
  formData.append('fileName', fileName);
  // 整个文件的总大小，不是单片大小
  formData.append('fileSize', fileSize.toString());
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
  fileName: string,
  fileSize: number,
  parentId: string | null,
  sessionId: string,
  token: string | null
): Promise<ChunkResult> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await uploadChunk(
        chunk,
        chunkIndex,
        totalChunks,
        fileName,
        fileSize,
        parentId,
        sessionId,
        token
      );

      if (result.success) {
        return result;
      }

      // 如果是最后一片且合并失败，直接返回错误
      if (chunkIndex === totalChunks - 1) {
        return result;
      }

      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY * attempt));
      }
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Upload failed',
        };
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY * attempt));
    }
  }

  return { success: false, error: 'Max retries exceeded' };
}

/** 固定并发度的任务池，任一任务失败后停止领取新任务 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  let failure: unknown = null;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length && !failure) {
      const item = items[cursor] as T;
      cursor++;
      try {
        await worker(item);
      } catch (error) {
        failure = error;
      }
    }
  });

  await Promise.all(runners);
  if (failure) throw failure;
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
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const sessionId = crypto.randomUUID();

  let completedChunks = 0;

  const uploadAt = async (index: number): Promise<ChunkResult> => {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    const result = await uploadChunkWithRetry(
      chunk,
      index,
      totalChunks,
      file.name,
      file.size,
      parentId,
      sessionId,
      token
    );

    if (!result.success) {
      throw new Error(result.error || `Chunk ${index + 1} failed`);
    }

    completedChunks++;
    onProgress(Math.round((completedChunks / totalChunks) * 100));
    onChunkComplete?.(completedChunks, totalChunks);

    return result;
  };

  try {
    // 首片单独发：服务端在这里创建 multipart 会话
    await uploadAt(0);

    // 中间分片并发上传
    const middleIndexes: number[] = [];
    for (let i = 1; i < totalChunks - 1; i++) {
      middleIndexes.push(i);
    }
    await runWithConcurrency(middleIndexes, CHUNK_CONCURRENCY, async (index) => {
      await uploadAt(index);
    });

    // 末片单独发：服务端校验分片齐全后合并，并返回文件对象
    const lastResult = await uploadAt(totalChunks - 1);
    if (lastResult.file) {
      return {
        success: true,
        file: {
          ...lastResult.file,
          parent_id: parentId,
        },
      };
    }

    return { success: false, error: 'No file data returned from server' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Upload failed',
    };
  }
}

/**
 * 检查是否应该使用分片上传
 */
export function shouldUseChunkedUpload(fileSize: number): boolean {
  return fileSize > CHUNK_SIZE; // 大于 5MB 使用分片上传
}
