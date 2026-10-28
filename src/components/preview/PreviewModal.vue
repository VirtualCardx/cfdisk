<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUIStore } from '@/stores/ui';
import { useFilesStore } from '@/stores/files';
import { api } from '@/api/client';
import { downloadWithProgress } from '@/utils/download';
import type { FileItem } from '@/stores/files';

type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other';

const uiStore = useUIStore();
const filesStore = useFilesStore();

const MAX_TEXT_BYTES = 5 * 1024 * 1024;

const file = computed<FileItem | null>(() => {
  if (uiStore.activeModal !== 'preview') return null;
  return (uiStore.modalData as FileItem | null) ?? null;
});

const kind = ref<PreviewKind>('other');
const src = ref('');
const textContent = ref('');
const originalText = ref('');
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const downloading = ref(false);
const downloadPercent = ref<number | null>(null);

// 文本：默认只读预览，可切换到编辑
const textMode = ref<'view' | 'edit'>('view');

// 图片查看器状态
const panelRef = ref<HTMLElement | null>(null);
const stageRef = ref<HTMLElement | null>(null);
const naturalSize = ref({ w: 0, h: 0 });
const scale = ref(1);
const rotation = ref(0);
const offset = ref({ x: 0, y: 0 });
const dragging = ref(false);
const pinching = ref(false);
const isFullscreen = ref(false);
const chromeHidden = ref(false);
let dragStart = { x: 0, y: 0, ox: 0, oy: 0 };

// 多指手势：pointerId -> 坐标
const pointers = new Map<number, { x: number; y: number }>();
let pinchStart: {
  dist: number;
  scale: number;
  midX: number;
  midY: number;
  ox: number;
  oy: number;
  cx: number;
  cy: number;
} | null = null;
let gestureStart = { x: 0, y: 0, moved: false, time: 0 };
let pinchHappened = false;
let tapTimer: number | undefined;
let lastTap = { time: 0, x: 0, y: 0 };
let lastTouchTapAt = 0;

// 打开预览时锁住页面滚动，避免移动端背景跟着滑动
let savedOverflow: string | null = null;
let savedOverscroll = '';

function lockBodyScroll(lock: boolean) {
  if (lock) {
    if (savedOverflow !== null) return;
    savedOverflow = document.body.style.overflow;
    savedOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    return;
  }

  if (savedOverflow === null) return;
  document.body.style.overflow = savedOverflow;
  document.body.style.overscrollBehavior = savedOverscroll;
  savedOverflow = null;
}

const dirty = computed(() => kind.value === 'text' && textContent.value !== originalText.value);
const scalePercent = computed(() => Math.max(1, Math.round(scale.value * 100)));
const textStats = computed(() => {
  const content = textContent.value;
  return {
    chars: content.length,
    lines: content ? content.split('\n').length : 0,
  };
});

// 同一目录下的其他图片，用于左右切换
const imageSiblings = computed(() =>
  filesStore.sortedFiles.filter(
    (f) => f.type === 'file' && (f.mime_type || '').toLowerCase().startsWith('image/')
  )
);
const siblingIndex = computed(() =>
  imageSiblings.value.findIndex((f) => f.id === file.value?.id)
);
const canSwitch = computed(() => imageSiblings.value.length > 1 && siblingIndex.value >= 0);

const TEXT_MIMES = ['application/json', 'application/xml', 'application/javascript', 'application/x-yaml'];

const TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.toml', '.ini', '.conf', '.env', '.xml', '.html', '.htm', '.css', '.scss',
  '.js', '.ts', '.jsx', '.tsx', '.vue', '.py', '.go', '.rs', '.java', '.c',
  '.cpp', '.h', '.hpp', '.sh', '.sql', '.gitignore', '.bat', '.ps1', '.rb',
  '.php', '.swift', '.kt', '.dockerfile', '.makefile',
];

function detectKind(f: FileItem): PreviewKind {
  const mime = (f.mime_type || '').toLowerCase();
  const name = f.name.toLowerCase();

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';

  if (mime.startsWith('text/') || TEXT_MIMES.includes(mime)) return 'text';
  if (TEXT_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'text';

  return 'other';
}

function resetViewer() {
  naturalSize.value = { w: 0, h: 0 };
  scale.value = 1;
  rotation.value = 0;
  offset.value = { x: 0, y: 0 };
  dragging.value = false;
  pinching.value = false;
  pointers.clear();
  pinchStart = null;
}

function reset() {
  kind.value = 'other';
  src.value = '';
  textContent.value = '';
  originalText.value = '';
  error.value = '';
  loading.value = false;
  textMode.value = 'view';
  chromeHidden.value = false;
  resetViewer();
}

async function open(f: FileItem) {
  reset();
  loading.value = true;
  kind.value = detectKind(f);

  try {
    if (kind.value === 'text') {
      if (f.size > MAX_TEXT_BYTES) {
        error.value = 'This file is too large to preview (max 5 MB). Download it instead.';
        return;
      }
      const data = await api.get<{ content: string }>(`/files/${f.id}/content`);
      textContent.value = data.content;
      originalText.value = data.content;
    } else if (kind.value !== 'other') {
      const data = await api.get<{ url: string }>(`/files/${f.id}/preview-token`);
      src.value = data.url;
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Failed to load preview';
  } finally {
    loading.value = false;
  }
}

watch(
  file,
  (f) => {
    if (f) {
      lockBodyScroll(true);
      open(f);
    } else {
      lockBodyScroll(false);
      reset();
    }
  },
  { immediate: true }
);

/* ---------------- 图片查看器 ---------------- */

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function computeFitScale(): number {
  const stage = stageRef.value;
  const { w, h } = naturalSize.value;
  if (!stage || !w || !h) return 1;

  const pad = 48;
  const cw = Math.max(stage.clientWidth - pad, 1);
  const ch = Math.max(stage.clientHeight - pad, 1);
  return clamp(Math.min(cw / w, ch / h), 0.02, 1);
}

let fittedScale = 1;

function fitToWindow() {
  scale.value = computeFitScale();
  fittedScale = scale.value;
  offset.value = { x: 0, y: 0 };
  rotation.value = 0;
}

function actualSize() {
  scale.value = 1;
  offset.value = { x: 0, y: 0 };
}

function zoomBy(factor: number) {
  scale.value = clamp(scale.value * factor, 0.02, 12);
  clampOffset();
}

function rotate() {
  rotation.value = (rotation.value + 90) % 360;
  clampOffset();
}

// 拖动 / 缩放时把画面限制在可视范围内，避免把图片完全推出屏幕
function clampOffset() {
  const stage = stageRef.value;
  const { w, h } = naturalSize.value;
  if (!stage || !w || !h) return;

  const rotated = rotation.value % 180 !== 0;
  const imgW = (rotated ? h : w) * scale.value;
  const imgH = (rotated ? w : h) * scale.value;
  const maxX = Math.max(0, (imgW - stage.clientWidth) / 2);
  const maxY = Math.max(0, (imgH - stage.clientHeight) / 2);

  offset.value = {
    x: clamp(offset.value.x, -maxX, maxX),
    y: clamp(offset.value.y, -maxY, maxY),
  };
}

function onImageLoad(event: Event) {
  const img = event.target as HTMLImageElement;
  naturalSize.value = { w: img.naturalWidth, h: img.naturalHeight };
  fitToWindow();
}

function onWheel(event: WheelEvent) {
  zoomBy(event.deltaY > 0 ? 0.9 : 1.1);
}

// 当前是否处于「放大 / 旋转」状态（用于判断能否横向滑动切图）
function isZoomed(): boolean {
  return scale.value > computeFitScale() * 1.02 || rotation.value % 360 !== 0;
}

// 双击 / 双击（移动端）：在「适应窗口」与「1:1」之间切换
function toggleZoom() {
  if (isZoomed()) {
    fitToWindow();
  } else {
    actualSize();
  }
}

function onDblClick() {
  // 触摸端的双击已由 settleTap 处理，避免重复触发
  if (Date.now() - lastTouchTapAt < 500) return;
  toggleZoom();
}

function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y) || 1;
}

function onPointerDown(event: PointerEvent) {
  if (kind.value !== 'image') return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  const el = event.currentTarget as HTMLElement;
  el.setPointerCapture?.(event.pointerId);
  // 新的触摸序列开始：清掉可能残留的指针（浏览器漏发 pointerup 时兜底）
  if (event.isPrimary) pointers.clear();
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size === 1) {
    dragging.value = true;
    pinchHappened = false;
    dragStart = {
      x: event.clientX,
      y: event.clientY,
      ox: offset.value.x,
      oy: offset.value.y,
    };
    gestureStart = { x: event.clientX, y: event.clientY, moved: false, time: Date.now() };
    return;
  }

  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return;
    const rect = stageRef.value?.getBoundingClientRect();
    pinchStart = {
      dist: pointerDistance(a, b),
      scale: scale.value,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      ox: offset.value.x,
      oy: offset.value.y,
      cx: rect ? rect.left + rect.width / 2 : 0,
      cy: rect ? rect.top + rect.height / 2 : 0,
    };
    dragging.value = false;
    pinching.value = true;
    pinchHappened = true;
    gestureStart.moved = true;
  }
}

function onPointerMove(event: PointerEvent) {
  if (kind.value !== 'image' || !pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  // 双指缩放：以两指中点为中心，保证画面不随手指漂移
  if (pointers.size >= 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return;
    const nextScale = clamp(pinchStart.scale * (pointerDistance(a, b) / pinchStart.dist), 0.02, 12);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const anchorX = pinchStart.midX - pinchStart.cx - pinchStart.ox;
    const anchorY = pinchStart.midY - pinchStart.cy - pinchStart.oy;
    const k = nextScale / pinchStart.scale;

    scale.value = nextScale;
    offset.value = {
      x: midX - pinchStart.cx - anchorX * k,
      y: midY - pinchStart.cy - anchorY * k,
    };
    clampOffset();
    return;
  }

  if (!dragging.value) return;

  const dx = event.clientX - dragStart.x;
  const dy = event.clientY - dragStart.y;
  if (Math.hypot(dx, dy) > 6) gestureStart.moved = true;

  offset.value = { x: dragStart.ox + dx, y: dragStart.oy + dy };
  clampOffset();
}

function settleTap(event: PointerEvent) {
  if (event.pointerType === 'mouse') return;

  const now = Date.now();
  lastTouchTapAt = now;
  const isDoubleTap =
    now - lastTap.time < 300 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 40;

  if (isDoubleTap) {
    lastTap.time = 0;
    window.clearTimeout(tapTimer);
    toggleZoom();
    return;
  }

  lastTap = { time: now, x: event.clientX, y: event.clientY };
  // 延迟执行，避免双击时先隐藏一次工具栏
  window.clearTimeout(tapTimer);
  tapTimer = window.setTimeout(() => {
    chromeHidden.value = !chromeHidden.value;
  }, 280);
}

function onPointerUp(event: PointerEvent) {
  if (event.type === 'pointercancel') {
    pointers.clear();
  } else {
    pointers.delete(event.pointerId);
  }

  // 双指松开一指：以剩下那根手指为新起点继续拖动
  if (pointers.size === 1) {
    const p = [...pointers.values()][0];
    if (!p) return;
    dragStart = { x: p.x, y: p.y, ox: offset.value.x, oy: offset.value.y };
    dragging.value = true;
    pinching.value = false;
    pinchStart = null;
    return;
  }

  if (pointers.size > 1) return;

  dragging.value = false;
  pinching.value = false;
  pinchStart = null;

  // 双指缩放结束后：缩得太小则回弹到适应窗口，否则把画面收进可视区域
  if (pinchHappened) {
    const fit = computeFitScale();
    if (scale.value < fit * 0.98) {
      scale.value = fit;
      fittedScale = fit;
      offset.value = { x: 0, y: 0 };
    } else {
      clampOffset();
    }
  }

  const dx = event.clientX - gestureStart.x;
  const dy = event.clientY - gestureStart.y;
  const dt = Date.now() - gestureStart.time;

  // 未放大时，单指横向快速滑动切换上一张 / 下一张（仅触摸 / 触控笔）
  if (
    event.pointerType !== 'mouse' &&
    !pinchHappened &&
    gestureStart.moved &&
    Math.abs(dx) > 64 &&
    Math.abs(dx) > Math.abs(dy) * 1.5 &&
    dt < 800 &&
    !isZoomed()
  ) {
    stepImage(dx < 0 ? 1 : -1);
    return;
  }

  if (!gestureStart.moved && dt < 500) settleTap(event);
  pinchHappened = false;
}

function stepImage(delta: number) {
  const list = imageSiblings.value;
  if (list.length < 2 || siblingIndex.value < 0) return;
  const next = (siblingIndex.value + delta + list.length) % list.length;
  uiStore.openModal('preview', list[next]);
}

async function toggleFullscreen() {
  const el = panelRef.value;
  if (!el) return;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await el.requestFullscreen();
    }
  } catch {
    // 用户拒绝或浏览器不支持时静默忽略
  }
}

function syncFullscreenState() {
  isFullscreen.value = !!document.fullscreenElement;
}

/* ---------------- 文本 / 通用 ---------------- */

async function save() {
  if (!file.value || saving.value || !dirty.value) return;

  saving.value = true;
  try {
    const data = await api.put<{ size: number }>(`/files/${file.value.id}/content`, {
      content: textContent.value,
    });
    originalText.value = textContent.value;
    file.value.size = data.size;
    uiStore.showToast('Saved', 'success');
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to save', 'error');
  } finally {
    saving.value = false;
  }
}

function editText() {
  textMode.value = 'edit';
  nextTick(() => {
    const area = document.querySelector<HTMLTextAreaElement>('.text-editor');
    area?.focus();
  });
}

async function download() {
  if (!file.value || downloading.value) return;

  const target = file.value;
  downloading.value = true;
  downloadPercent.value = null;
  try {
    await downloadWithProgress(`/api/files/${target.id}/download`, target.name, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      onProgress: (progress) => {
        downloadPercent.value = progress.percent;
      },
    });
  } catch (e: unknown) {
    uiStore.showToast(e instanceof Error ? e.message : 'Failed to download', 'error');
  } finally {
    downloading.value = false;
    downloadPercent.value = null;
  }
}

/** 下载按钮上的文案：有百分比就显示，没有就显示 Preparing… */
const downloadLabel = computed(() => {
  if (!downloading.value) return 'Download';
  return downloadPercent.value === null ? 'Downloading…' : `Downloading ${downloadPercent.value}%`;
});

function close() {
  if (dirty.value && !window.confirm('Discard unsaved changes?')) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => undefined);
  }
  uiStore.closeModal();
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function onKeydown(event: KeyboardEvent) {
  if (!file.value) return;

  if (event.key === 'Escape') {
    close();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save();
    return;
  }

  if (isTypingTarget(event.target)) return;

  if (kind.value === 'image') {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      stepImage(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      stepImage(1);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomBy(1.1);
    } else if (event.key === '-') {
      event.preventDefault();
      zoomBy(0.9);
    } else if (event.key === '0') {
      event.preventDefault();
      fitToWindow();
    } else if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      rotate();
    }
  }
}

function onResize() {
  if (kind.value !== 'image' || !naturalSize.value.w) return;
  // 用户没有手动缩放时，跟随窗口重新适配
  if (Math.abs(scale.value - fittedScale) < 0.001) fitToWindow();
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', syncFullscreenState);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onResize);
  document.removeEventListener('fullscreenchange', syncFullscreenState);
  window.clearTimeout(tapTimer);
  lockBodyScroll(false);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="file" class="preview-overlay" :class="{ 'is-image': kind === 'image' }" @click.self="close">
      <div
        ref="panelRef"
        class="preview-panel"
        :class="{ 'is-image': kind === 'image', 'chrome-hidden': chromeHidden }"
      >
        <header class="preview-header">
          <div class="file-info">
            <span class="file-name" :title="file.name">{{ file.name }}</span>
            <span class="file-meta">
              {{ formatBytes(file.size) }}
              <template v-if="kind === 'image' && naturalSize.w">
                · {{ naturalSize.w }} × {{ naturalSize.h }} px
              </template>
              <template v-else-if="kind === 'text' && !loading && !error">
                · {{ textStats.lines }} lines · {{ textStats.chars }} chars
              </template>
            </span>
          </div>

          <div class="header-actions">
            <div v-if="kind === 'text' && !loading && !error" class="mode-switch">
              <button :class="{ active: textMode === 'view' }" @click="textMode = 'view'">Preview</button>
              <button :class="{ active: textMode === 'edit' }" @click="editText">Edit</button>
            </div>
            <button
              v-if="kind === 'text' && textMode === 'edit'"
              class="btn-primary"
              :disabled="!dirty || saving"
              @click="save"
            >
              {{ saving ? 'Saving…' : 'Save' }}
            </button>
            <button class="btn-secondary" :disabled="downloading" @click="download">
              {{ downloadLabel }}
            </button>
            <button class="btn-icon" title="Close" @click="close">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        <div class="preview-body" :class="{ dark: kind === 'image' }">
          <div v-if="loading" class="state">Loading…</div>

          <div v-else-if="error" class="state error">
            <p>{{ error }}</p>
            <button class="btn-primary" :disabled="downloading" @click="download">
              {{ downloadLabel === 'Download' ? 'Download file' : downloadLabel }}
            </button>
          </div>

          <template v-else-if="kind === 'image'">
            <div
              ref="stageRef"
              class="image-stage"
              :class="{ dragging, pinching }"
              @wheel.prevent="onWheel"
              @pointerdown="onPointerDown"
              @pointermove="onPointerMove"
              @pointerup="onPointerUp"
              @pointercancel="onPointerUp"
              @dblclick="onDblClick"
            >
              <img
                :src="src"
                :alt="file.name"
                class="viewer-image"
                :style="{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotation}deg)`,
                }"
                draggable="false"
                @load="onImageLoad"
              />
            </div>

            <div class="image-toolbar" @click.stop>
              <button
                class="tool-btn"
                :disabled="!canSwitch"
                title="Previous image (←)"
                @click="stepImage(-1)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>

              <span class="divider"></span>

              <button class="tool-btn" title="Zoom out (-)" @click="zoomBy(0.9)">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="11" cy="11" r="7" /><line x1="8" y1="11" x2="14" y2="11" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>

              <button class="zoom-label" title="Fit to window (0)" @click="fitToWindow">
                {{ scalePercent }}%
              </button>

              <button class="tool-btn" title="Zoom in (+)" @click="zoomBy(1.1)">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="11" cy="11" r="7" /><line x1="8" y1="11" x2="14" y2="11" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>

              <button class="tool-text desktop-only" title="Actual size (100%)" @click="actualSize">1:1</button>

              <span class="divider"></span>

              <button class="tool-btn" title="Rotate 90° (R)" @click="rotate">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
                </svg>
              </button>

              <button class="tool-btn desktop-only" :title="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'" @click="toggleFullscreen">
                <svg v-if="!isFullscreen" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3" />
                </svg>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M8 3v3a2 2 0 01-2 2H3M16 3v3a2 2 0 002 2h3M8 21v-3a2 2 0 00-2-2H3M16 21v-3a2 2 0 012-2h3" />
                </svg>
              </button>

              <span class="divider"></span>

              <button
                class="tool-btn"
                :disabled="!canSwitch"
                title="Next image (→)"
                @click="stepImage(1)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>

              <span v-if="canSwitch" class="position">{{ siblingIndex + 1 }} / {{ imageSiblings.length }}</span>
            </div>
          </template>

          <video v-else-if="kind === 'video'" :src="src" controls class="media-video"></video>

          <audio v-else-if="kind === 'audio'" :src="src" controls class="media-audio"></audio>

          <iframe v-else-if="kind === 'pdf'" :src="src" class="media-pdf" :title="file.name"></iframe>

          <pre v-else-if="kind === 'text' && textMode === 'view'" class="text-preview">{{ textContent }}</pre>

          <textarea
            v-else-if="kind === 'text'"
            v-model="textContent"
            class="text-editor"
            spellcheck="false"
          ></textarea>

          <div v-else class="state">
            <p class="no-preview">No preview available for this file type</p>
            <p class="hint">{{ file.mime_type || 'unknown type' }}</p>
            <button class="btn-primary" :disabled="downloading" @click="download">
              {{ downloadLabel === 'Download' ? 'Download file' : downloadLabel }}
            </button>
          </div>
        </div>

        <footer v-if="kind === 'text' && !loading && !error" class="preview-footer">
          <span v-if="textMode === 'edit'">Ctrl / ⌘ + S to save</span>
          <span v-else>Read-only preview · click Edit to modify</span>
          <span v-if="dirty" class="dirty">Unsaved changes</span>
        </footer>

        <footer v-else-if="kind === 'image' && !loading && !error" class="preview-footer image-footer">
          <span>Pinch or scroll to zoom · drag to pan · swipe / ← → to switch · double-tap for 1:1</span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 900;
  padding: 2rem;
}

.preview-panel {
  background: #fff;
  border-radius: 12px;
  width: min(1100px, 100%);
  height: min(80vh, 900px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
}

/* 图片预览：PC / 移动端都铺满整个视口 */
.preview-overlay.is-image {
  padding: 0;
  background: #0b1220;
}

.preview-panel.is-image {
  width: 100%;
  max-width: none;
  height: 100%;
  border-radius: 0;
  box-shadow: none;
  overscroll-behavior: none;
  background: #0b1220;
}

/* 图片模式下顶栏 / 底栏切换为深色，与画布连成一体 */
.preview-panel.is-image .preview-header {
  background: #0b1220;
  border-bottom-color: #1e293b;
  padding-top: calc(0.875rem + env(safe-area-inset-top, 0px));
}

.preview-panel.is-image .file-name {
  color: #e2e8f0;
}

.preview-panel.is-image .file-meta {
  color: #7b89a3;
}

.preview-panel.is-image .btn-secondary {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.16);
  color: #e2e8f0;
}

.preview-panel.is-image .btn-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.16);
}

.preview-panel.is-image .btn-icon {
  color: #94a3b8;
}

.preview-panel.is-image .btn-icon:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.875rem 1.25rem;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
  background: #fff;
}

.file-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.file-name {
  font-weight: 600;
  color: #0f172a;
  font-size: 0.9375rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-meta {
  font-size: 0.75rem;
  color: #64748b;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.mode-switch {
  display: flex;
  background: #f1f5f9;
  border-radius: 8px;
  padding: 2px;
  margin-right: 0.25rem;
}

.mode-switch button {
  border: none;
  background: transparent;
  color: #64748b;
  font-size: 0.78rem;
  font-weight: 500;
  padding: 0.35rem 0.7rem;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}

.mode-switch button.active {
  background: #fff;
  color: #1e40af;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
}

.btn-primary,
.btn-secondary,
.btn-icon {
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 500;
  padding: 0.5rem 0.875rem;
  transition: all 0.15s ease;
}

.btn-primary {
  background: #1e40af;
  border: 1px solid #1e40af;
  color: #fff;
}

.btn-primary:disabled {
  background: #cbd5e1;
  border-color: #cbd5e1;
  cursor: not-allowed;
}

.btn-secondary {
  background: #fff;
  border: 1px solid #cbd5e1;
  color: #475569;
}

.btn-secondary:hover:not(:disabled) {
  background: #f1f5f9;
}

.btn-icon {
  background: transparent;
  border: none;
  color: #64748b;
  padding: 0.5rem;
  display: flex;
}

.btn-icon:hover {
  background: #f1f5f9;
  color: #0f172a;
}

.preview-body {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f8fafc;
  overflow: auto;
}

.preview-body.dark {
  background: #0b1220;
  overflow: hidden;
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  color: #64748b;
  font-size: 0.875rem;
  text-align: center;
  padding: 2rem;
}

.state.error {
  color: #b91c1c;
}

.state.error p {
  margin: 0;
  max-width: 40ch;
  line-height: 1.6;
}

.no-preview {
  margin: 0;
  font-size: 1rem;
  color: #334155;
}

.hint {
  margin: 0;
  font-size: 0.75rem;
  color: #94a3b8;
}

/* ---------- 图片查看器 ---------- */

.image-stage {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}

.image-stage.dragging {
  cursor: grabbing;
}

.viewer-image {
  max-width: none;
  max-height: none;
  transform-origin: center center;
  will-change: transform;
  user-select: none;
  -webkit-user-drag: none;
  -webkit-touch-callout: none;
  transition: transform 0.12s ease-out;
}

.image-stage.dragging .viewer-image,
.image-stage.pinching .viewer-image {
  transition: none;
}

/* 移动端单击画面：收起 / 展开顶栏与工具栏，获得纯图查看体验 */
.preview-header,
.preview-footer,
.image-toolbar {
  transition: opacity 0.22s ease;
}

.preview-panel.chrome-hidden .preview-header,
.preview-panel.chrome-hidden .preview-footer {
  opacity: 0;
  pointer-events: none;
}

.preview-panel.chrome-hidden .image-toolbar {
  opacity: 0;
  pointer-events: none;
}

.image-toolbar {
  position: absolute;
  left: 50%;
  bottom: 1rem;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.375rem 0.5rem;
  background: rgba(15, 23, 42, 0.82);
  backdrop-filter: blur(8px);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  z-index: 2;
}

.tool-btn,
.tool-text,
.zoom-label {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  padding: 0 0.4rem;
  border: none;
  background: transparent;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.78rem;
  font-weight: 500;
  transition: background 0.15s, color 0.15s;
}

.tool-btn:hover:not(:disabled),
.tool-text:hover,
.zoom-label:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}

.tool-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.zoom-label {
  min-width: 52px;
  font-variant-numeric: tabular-nums;
}

.divider {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.18);
  margin: 0 0.2rem;
}

.position {
  font-size: 0.72rem;
  color: #94a3b8;
  padding: 0 0.35rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ---------- 媒体 ---------- */

.media-video {
  max-width: 100%;
  max-height: 100%;
  background: #000;
}

.media-audio {
  width: min(560px, 90%);
}

.media-pdf {
  width: 100%;
  height: 100%;
  border: none;
}

/* ---------- 文本 ---------- */

.text-preview {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 1.25rem 1.5rem;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8125rem;
  line-height: 1.75;
  color: #0f172a;
  background: #fff;
  white-space: pre-wrap;
  word-break: break-word;
  tab-size: 2;
  box-sizing: border-box;
}

.text-editor {
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  resize: none;
  padding: 1.25rem 1.5rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8125rem;
  line-height: 1.7;
  color: #0f172a;
  background: #fff;
  tab-size: 2;
  box-sizing: border-box;
}

.preview-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 1.25rem;
  border-top: 1px solid #e2e8f0;
  font-size: 0.72rem;
  color: #94a3b8;
  flex-shrink: 0;
  background: #fff;
}

.preview-footer.image-footer {
  justify-content: center;
  border-top-color: #1e293b;
  background: #0b1220;
  color: #64748b;
}

.dirty {
  color: #b45309;
}

@media (max-width: 768px) {
  .preview-overlay {
    padding: 0;
  }

  .preview-panel {
    width: 100%;
    height: 100dvh;
    border-radius: 0;
  }

  .file-meta {
    max-width: 40vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mode-switch {
    display: none;
  }

  /* 移动端：工具栏贴近安全区，按钮加大到适合手指点击 */
  .image-toolbar {
    bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
    gap: 0;
    max-width: calc(100vw - 1.5rem);
    padding: 0.25rem;
  }

  .tool-btn,
  .zoom-label {
    min-width: 44px;
    height: 44px;
    font-size: 0.82rem;
  }

  .zoom-label {
    min-width: 64px;
  }

  .desktop-only {
    display: none !important;
  }

  .divider {
    display: none;
  }

  .position {
    font-size: 0.7rem;
    padding: 0 0.25rem;
  }

  /* 移动端不显示操作提示条，把高度全部留给图片 */
  .preview-footer.image-footer {
    display: none;
  }
}
</style>
