<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUIStore } from '@/stores/ui';
import type { FileItem } from '@/stores/files';

/**
 * 文件 / 文件夹右键菜单。
 *
 * 只负责「长什么样、点到了哪一项」，具体动作通过 `action` 事件交回调用方——
 * 菜单本身不该知道怎么重命名或移动，否则同一个菜单在回收站、分享列表里就没法复用。
 *
 * 两个容易被忽略的细节：
 * 1. 定位 —— 菜单渲染出来才知道自己多高，所以先按鼠标位置摆放，nextTick 量到尺寸后
 *    再往回收，保证靠右/靠下边缘右键时菜单不会跑出视口；
 * 2. 关闭 —— 用捕获阶段的 pointerdown 判断「点在菜单外」，比 click 更早生效，
 *    避免菜单还没关掉下面那层就先响应了。滚动和窗口尺寸变化也要关，
 *    否则菜单会悬在原地跟内容脱节。
 */

const emit = defineEmits<{ (e: 'action', key: string, file: FileItem): void }>();

const props = defineProps<{
  /** 当前选中的条目数；> 1 时菜单切换成批量语境 */
  selectionCount?: number;
}>();

interface MenuEntry {
  key?: string;
  label?: string;
  danger?: boolean;
  divider?: boolean;
}

const uiStore = useUIStore();

const menuEl = ref<HTMLElement | null>(null);
const left = ref(0);
const top = ref(0);
const visible = ref(false);

const file = computed(() => uiStore.contextMenu?.file ?? null);

/**
 * 多选状态下的菜单必须只留批量操作。
 *
 * Share / Rename / View details 天然只作用于单个文件，混在「已选 3 项」的菜单里，
 * 用户会以为点下去是对三项都生效——所以多选时直接把这几项摘掉，只留能给整批用的两个。
 */
const isMulti = computed(() => (props.selectionCount ?? 0) > 1);

const entries = computed<MenuEntry[]>(() => {
  const current = file.value;
  if (!current) return [];

  if (isMulti.value) {
    return [
      { key: 'move', label: 'Move…' },
      { key: 'delete', label: 'Move to Trash', danger: true },
    ];
  }

  const isFile = current.type === 'file';
  const items: MenuEntry[] = [
    { key: 'open', label: isFile ? 'Preview' : 'Open' },
    { key: 'share', label: 'Share' },
  ];
  if (isFile) items.push({ key: 'download', label: 'Download' });

  items.push(
    { divider: true },
    { key: 'rename', label: 'Rename' },
    { key: 'move', label: 'Move to…' },
    { key: 'info', label: 'View details' },
    { divider: true },
    { key: 'delete', label: 'Move to Trash', danger: true }
  );

  return items;
});

watch(
  () => uiStore.contextMenu,
  async (menu) => {
    if (!menu) {
      visible.value = false;
      return;
    }

    left.value = menu.x;
    top.value = menu.y;
    visible.value = true;

    await nextTick();
    const rect = menuEl.value?.getBoundingClientRect();
    if (!rect) return;

    const margin = 8;
    left.value = Math.min(menu.x, Math.max(margin, window.innerWidth - rect.width - margin));
    top.value = Math.min(menu.y, Math.max(margin, window.innerHeight - rect.height - margin));
  }
);

/**
 * 先把目标文件取出来再关菜单。
 *
 * hideContextMenu 会把 store 里的 contextMenu 置空，而 file 是它的 computed，
 * 所以顺序反了的话父组件收到的永远是 null —— 菜单看着能点，实际上什么都不会发生。
 */
function choose(key?: string): void {
  const target = file.value;
  if (!key || !target) return;
  uiStore.hideContextMenu();
  emit('action', key, target);
}

function onPointerDown(event: PointerEvent): void {
  if (!visible.value) return;
  const target = event.target;
  if (menuEl.value && target instanceof Node && menuEl.value.contains(target)) return;
  uiStore.hideContextMenu();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') uiStore.hideContextMenu();
}

function onViewportChange(): void {
  if (visible.value) uiStore.hideContextMenu();
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible && file"
      ref="menuEl"
      class="ctx-menu"
      :style="{ left: `${left}px`, top: `${top}px` }"
      role="menu"
      @contextmenu.prevent
    >
      <div v-if="isMulti" class="ctx-head">{{ selectionCount }} items selected</div>
      <template v-for="(entry, index) in entries" :key="entry.key ?? `sep-${index}`">
        <div v-if="entry.divider" class="ctx-sep" role="separator"></div>
        <button
          v-else
          type="button"
          class="ctx-item"
          :class="{ danger: entry.danger }"
          role="menuitem"
          @click="choose(entry.key)"
        >
          {{ entry.label }}
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 300;
  min-width: 188px;
  padding: 6px;
  background: #ffffff;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 12px;
  box-shadow:
    0 12px 32px rgba(15, 23, 42, 0.16),
    0 2px 6px rgba(15, 23, 42, 0.06);
  user-select: none;
  animation: ctx-in 0.12s ease-out;
}

@keyframes ctx-in {
  from {
    opacity: 0;
    transform: scale(0.97);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.ctx-item {
  display: block;
  width: 100%;
  padding: 9px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #1e293b;
  font-size: 14px;
  line-height: 1.2;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}

.ctx-item:hover {
  background: #f1f5f9;
}

.ctx-item:focus-visible {
  outline: 2px solid #93c5fd;
  outline-offset: -2px;
}

.ctx-item.danger {
  color: #dc2626;
}

.ctx-item.danger:hover {
  background: #fef2f2;
}

.ctx-sep {
  height: 1px;
  margin: 6px 8px;
  background: rgba(15, 23, 42, 0.08);
}

.ctx-head {
  padding: 4px 12px 8px;
  margin-bottom: 4px;
  font-size: 12px;
  color: #64748b;
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
}

@media (prefers-reduced-motion: reduce) {
  .ctx-menu {
    animation: none;
  }
}
</style>
