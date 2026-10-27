<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useFilesStore, type FileItem } from '@/stores/files';
import { useUploadStore } from '@/stores/upload';
import { createThumbnail, isThumbnailableImage, uploadThumbnail } from '@/utils/thumbnail';

/**
 * 图片缩略图。
 *
 * 优先用服务端已生成的缩略图（`file.thumb_url`，几十 KB，带长缓存），
 * 只有历史文件（上传功能上线前传的）没有缩略图时，才走一次「下载原图 → 前端缩图 → 回传」，
 * 之后永久命中缩略图。
 *
 * 三条边界：
 * 1. 懒加载 —— 滚动进入视口（含 300px 预取边距）才发起请求，避免一屏几十个并发；
 * 2. 回填有上限 —— 超过 BACKFILL_MAX_BYTES 的历史大图不再下载原图，直接显示图标；
 * 3. 刚上传的文件不等回填 —— 上传侧正在用内存里的原图生成，重复下载原图纯属浪费。
 */

/** 历史文件回填时允许下载的原图上限（新上传的文件不受此限制） */
const BACKFILL_MAX_BYTES = 20 * 1024 * 1024;

/** 上传侧的缩略图作业还没结束时的等待时间 */
const PENDING_RETRY_DELAY = 1500;

const props = defineProps<{ file: FileItem }>();

const filesStore = useFilesStore();
const uploadStore = useUploadStore();

const root = ref<HTMLElement | null>(null);
const src = ref('');
const failed = ref(false);
const loaded = ref(false);

let requested = false;
let objectUrl: string | null = null;
let observer: IntersectionObserver | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;

function setSource(url: string): void {
  src.value = url;
  loaded.value = false;
}

// 服务端缩略图晚到（上传侧回传、或回填成功后 store 更新）时补上
watch(
  () => props.file.thumb_url,
  (url) => {
    if (url && !src.value) {
      failed.value = false;
      setSource(url);
    }
  }
);

function scheduleRetry(delay = PENDING_RETRY_DELAY): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!disposed) void load();
  }, delay);
}

async function load(): Promise<void> {
  if (disposed || failed.value || src.value) return;
  if (requested) return;
  requested = true;

  try {
    // 1. 已有服务端缩略图：直接显示，逻辑到此为止
    if (props.file.thumb_url) {
      setSource(props.file.thumb_url);
      return;
    }

    if (!isThumbnailableImage(props.file.mime_type)) {
      failed.value = true;
      return;
    }

    // 2. 刚上传，缩略图正在生成中 —— 等它，别去下载原图
    if (uploadStore.pendingThumbs.has(props.file.id)) {
      requested = false;
      scheduleRetry();
      return;
    }

    // 3. 上传侧已经尝试过但没能生成（格式异常等），不再重复下载
    if (uploadStore.thumbAttempted.has(props.file.id)) {
      failed.value = true;
      return;
    }

    // 4. 历史文件回填：只对大图设限
    if (props.file.size > BACKFILL_MAX_BYTES) {
      failed.value = true;
      return;
    }

    const data = await api.get<{ url: string }>(`/files/${props.file.id}/preview-token`);
    const response = await fetch(data.url);
    if (!response.ok) throw new Error(`Preview failed: ${response.status}`);

    const blob = await response.blob();
    const thumb = await createThumbnail(blob);
    if (!thumb) {
      failed.value = true;
      return;
    }

    // 先用本地 objectURL 立刻显示，再后台上传，用户不需要等第二次往返
    objectUrl = URL.createObjectURL(thumb);
    setSource(objectUrl);

    const url = await uploadThumbnail(props.file.id, thumb);
    if (url) filesStore.setThumbUrl(props.file.id, url);
  } catch {
    failed.value = true;
  }
}

function onError(): void {
  // 签名或对象失效：退回图标，不做无限重试
  failed.value = true;
  src.value = '';
  loaded.value = false;
}

onMounted(() => {
  const el = root.value;
  if (!el) return;

  if (typeof IntersectionObserver === 'undefined') {
    void load();
    return;
  }

  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        observer = null;
        void load();
      }
    },
    { rootMargin: '300px 0px' }
  );
  observer.observe(el);
});

onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  observer = null;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
});
</script>

<template>
  <div ref="root" class="thumb">
    <!-- 骨架先出现，图片加载完成后覆盖上来：避免「图标 → 骨架 → 图片」三段跳 -->
    <div v-if="!loaded && !failed" class="thumb-skeleton"></div>
    <img
      v-if="src && !failed"
      :src="src"
      alt=""
      class="thumb-img"
      :class="{ loaded }"
      decoding="async"
      draggable="false"
      @load="loaded = true"
      @error="onError"
    />
    <slot v-if="failed"></slot>
  </div>
</template>

<style scoped>
.thumb {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 8px;
}

/*
 * 不要给这里加 z-index。
 *
 * 缩略图与骨架都是定位元素，DOM 顺序已经保证图片画在骨架之上；
 * 一旦加上 z-index（哪怕只是 1），它就会盖住卡片右上角的操作按钮
 * （`.file-actions` 是 z-index: auto 的绝对定位元素），
 * 按钮不仅看不见，点击也会被图片吞掉。
 */
.thumb-img {
  position: relative;
  width: 100%;
  height: 100%;
  /*
   * contain 而不是 cover：缩略图区域是「卡片宽 × 96px」的扁矩形，
   * cover 会把竖图、超宽图裁掉一大截，用户只能看到画面局部（人脸常被裁掉半张）。
   * contain 保证整张图完整可见，代价是比例不匹配时四周留白，
   * 用下面的浅色底把留白填成中性的「相框」，比露出卡片底色更干净。
   */
  object-fit: contain;
  object-position: center;
  background: #f1f5f9;
  display: block;
  opacity: 0;
  transition: opacity 0.2s ease;
  user-select: none;
  -webkit-user-drag: none;
}

.thumb-img.loaded {
  opacity: 1;
}

.thumb-skeleton {
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, #e2e8f0 30%, #f1f5f9 50%, #e2e8f0 70%);
  background-size: 200% 100%;
  animation: thumb-shimmer 1.2s ease-in-out infinite;
}

@keyframes thumb-shimmer {
  from {
    background-position: 150% 0;
  }
  to {
    background-position: -50% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .thumb-skeleton {
    animation: none;
  }
}
</style>
