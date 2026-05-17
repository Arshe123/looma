<script setup lang="ts">
import { computed, ref } from 'vue'
import { Bell, Check, Cloud, Code2, GripVertical, Monitor, Plus, RotateCcw, Trash2 } from 'lucide-vue-next'
import { useSettingsStore } from '../store/settings'
import {
  inlineMenuActionLabel,
  resolveInlineMenuItems,
  getMenuActions
} from '@/common/util/tiptap-menu-actions'

const activeSection = ref('appearance')
const draggedInlineMenuIndex = ref<number | null>(null)
const settingsStore = useSettingsStore()

const settingSections = [
  {
    id: 'appearance',
    title: '主题',
    description: '管理界面主题与窗口显示偏好。',
    icon: Monitor,
    items: ['跟随系统主题', '紧凑侧边栏', '减少界面动效'],
  },
  {
    id: 'editor',
    title: '编辑器',
    description: '配置 Markdown 编辑器的快捷插入菜单。',
    icon: Code2,
  },
]

const currentSection = computed(() => {
  return settingSections.find((section) => section.id === activeSection.value) ?? settingSections[0]
})

const isEditorSection = computed(() => currentSection.value.id === 'editor')
const currentInlineMenuActions = computed(() => resolveInlineMenuItems(settingsStore.inlineMenuItems))

const isInlineMenuActionAdded = (id: string) => settingsStore.inlineMenuItems.includes(id)

const moveInlineMenuItem = (toIndex: number) => {
  if (draggedInlineMenuIndex.value === null) return
  settingsStore.moveInlineMenuItem(draggedInlineMenuIndex.value, toIndex)
  draggedInlineMenuIndex.value = null
}
</script>

<template>
  <main class="flex-1 overflow-hidden bg-surface">
    <div class="mx-auto flex h-full w-full max-w-6xl flex-col px-5 py-6 md:px-8">
      <div class="mb-6 shrink-0">
        <h1 class="text-2xl font-semibold text-text-main">系统设置</h1>
        <p class="mt-2 text-sm text-text-muted">管理应用级偏好，这些设置会持久化保留。</p>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <nav
          class="shrink-0 rounded-lg border border-border-soft bg-panel p-2 lg:w-32"
          aria-label="设置分类"
          data-testid="settings-section-nav"
        >
          <button
            v-for="section in settingSections"
            :key="section.id"
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors"
            :class="[
              activeSection === section.id
                ? 'bg-accent-soft text-text-main'
                : 'text-text-muted hover:bg-accent-soft hover:text-text-main'
            ]"
            data-testid="settings-section-button"
            @click="activeSection = section.id"
          >
            <span
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
              :class="activeSection === section.id ? 'bg-panel text-accent' : 'bg-panel-soft text-text-muted'"
            >
              <component :is="section.icon" :size="16" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ section.title }}</span>
            </span>
          </button>
        </nav>

        <section
          class="flex min-h-0 flex-1 flex-col rounded-lg border border-border-soft bg-panel"
          data-testid="settings-section-content"
        >
          <div
            class="min-h-0 flex-1 overflow-auto p-5"
            data-testid="settings-section-scroll-body"
          >
            <div v-if="isEditorSection" class="flex min-h-0 flex-col gap-4">
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
                  <div
                    class="shrink-0 rounded-lg border border-border-soft bg-surface/40 p-3"
                  >
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

            <div v-else class="space-y-3">
              <label
                v-for="item in currentSection.items"
                :key="item"
                class="flex items-center justify-between gap-4 rounded-md bg-panel-soft px-4 py-3 text-sm text-text-main"
              >
                <span class="min-w-0 truncate">{{ item }}</span>
                <input type="checkbox" class="h-4 w-4 shrink-0 accent-[var(--color-accent)]" />
              </label>
            </div>
          </div>
        </section>
      </div>
    </div>
  </main>
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
