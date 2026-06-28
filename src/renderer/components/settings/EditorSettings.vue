<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, GripVertical, Plus, RotateCcw, Trash2 } from 'lucide-vue-next'
import { useSettingsStore } from '@/renderer/stores/settings'
import {
  getMenuActions,
  inlineMenuActionLabel,
  resolveInlineMenuItems,
} from '@/shared/utils/tiptap-menu-actions'

const settingsStore = useSettingsStore()
const draggedInlineMenuIndex = ref<number | null>(null)

const currentInlineMenuActions = computed(() => resolveInlineMenuItems(settingsStore.inlineMenuItems))

const isInlineMenuActionAdded = (id: string) => settingsStore.inlineMenuItems.includes(id)

const moveInlineMenuItem = (toIndex: number) => {
  if (draggedInlineMenuIndex.value === null) return
  settingsStore.moveInlineMenuItem(draggedInlineMenuIndex.value, toIndex)
  draggedInlineMenuIndex.value = null
}
</script>

<template>
  <div class="flex min-h-0 flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div class="text-sm font-medium text-text-main">富文本编辑器快速插入菜单</div>
        <p class="mt-1 text-xs leading-5 text-text-muted">
          删除会从空行旁 + 菜单移除该操作，可从右侧操作列表重新添加。
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-md border border-border-soft bg-panel-soft px-3 py-2 text-xs text-text-main transition-colors hover:bg-accent-soft"
          @click="settingsStore.resetInlineMenu()"
        >
          <RotateCcw :size="14" />
          <span>恢复默认菜单</span>
        </button>
      </div>
    </div>

    <div
      class="grid grid-cols-2 min-h-0 w-max min-w-full gap-4"
      data-testid="inline-menu-transfer-row"
    >
      <div class="flex-none rounded-lg border border-border-soft bg-surface/40 p-3">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div>
            <div class="text-sm font-medium text-text-main">当前菜单</div>
            <div class="mt-1 text-xs text-text-muted">{{ currentInlineMenuActions.length }} 个操作</div>
          </div>
        </div>

        <TransitionGroup
          name="inline-menu-list"
          tag="div"
          class="max-h-[400px] space-y-2 overflow-y-auto pr-1"
          data-testid="inline-menu-settings-list"
        >
          <div
            v-for="(item, index) in currentInlineMenuActions"
            :key="item.id"
            class="flex items-center gap-3 rounded-md bg-panel-soft px-3 py-2 text-sm text-text-main transition-colors hover:bg-accent-soft/60"
            draggable="true"
            data-testid="inline-menu-settings-item"
            @dragstart="draggedInlineMenuIndex = index"
            @dragover.prevent
            @drop.prevent="moveInlineMenuItem(index)"
            @dragend="draggedInlineMenuIndex = null"
          >
            <GripVertical :size="16" class="shrink-0 cursor-grab text-text-subtle" />
            <component :is="item.icon" :size="16" class="shrink-0 text-text-muted" />
            <span class="min-w-0 flex-1 truncate">{{ inlineMenuActionLabel(item.id) }}</span>
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-danger/10 hover:text-danger"
              title="删除"
              data-testid="inline-menu-remove-action-button"
              @click="settingsStore.removeInlineMenuItem(item.id)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </TransitionGroup>

        <div
          v-if="currentInlineMenuActions.length === 0"
          class="rounded-md border border-dashed border-border-soft px-4 py-8 text-center text-sm text-text-muted"
        >
          当前菜单为空。可从右侧添加操作。
        </div>
      </div>

      <Transition name="inline-menu-panel">
        <div class="shrink-0 rounded-lg border border-border-soft bg-surface/40 p-3">
          <div class="mb-3">
            <div class="text-sm font-medium text-text-main">其他操作</div>
            <div class="mt-1 text-xs text-text-muted">从这里可以添加未添加的快捷操作。</div>
          </div>

          <TransitionGroup
            name="inline-menu-list"
            tag="div"
            class="max-h-[360px] space-y-2 overflow-y-auto pr-1"
            data-testid="inline-menu-all-actions-list"
          >
            <button
              v-for="item in getMenuActions().filter((item) => !isInlineMenuActionAdded(item.id))"
              :key="item.id"
              type="button"
              class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors bg-panel-soft text-text-main hover:bg-accent-soft"
              @click="settingsStore.addInlineMenuItem(item.id)"
            >
              <component :is="item.icon" :size="16" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
              <Check v-if="isInlineMenuActionAdded(item.id)" :size="14" class="shrink-0" />
              <Plus v-else :size="14" class="shrink-0 text-accent" />
            </button>
          </TransitionGroup>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.inline-menu-list-move,
.inline-menu-list-enter-active,
.inline-menu-list-leave-active {
  transition: all 180ms ease;
}

.inline-menu-list-enter-from,
.inline-menu-list-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.inline-menu-list-leave-active {
  position: absolute;
}

.inline-menu-panel-enter-active,
.inline-menu-panel-leave-active {
  transition: opacity 180ms ease, transform 180ms ease, max-width 180ms ease;
  overflow: hidden;
}

.inline-menu-panel-enter-from,
.inline-menu-panel-leave-to {
  max-width: 0;
  opacity: 0;
  transform: translateX(12px);
}

.inline-menu-panel-enter-to,
.inline-menu-panel-leave-from {
  max-width: 320px;
  opacity: 1;
  transform: translateX(0);
}
</style>
