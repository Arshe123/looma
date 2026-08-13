<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  Check,
  FileText,
  Folders,
  GripVertical,
  Heading,
  Keyboard,
  ListTree,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-vue-next'
import { useSettingsStore } from '@/renderer/stores/settings'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import {
  getMenuActions,
  inlineMenuActionLabel,
  resolveInlineMenuItems,
} from '@/shared/utils/tiptap-menu-actions'
import {
  editorShortcutSignature,
  formatEditorShortcut,
  shortcutFromKeyboardEvent,
  type EditorShortcutBinding,
} from '@/shared/utils/editor-shortcuts'
import {
  appShortcutFromKeyboardEvent,
  createDefaultAppShortcutSettings,
  getAppShortcutDefinitions,
  type AppShortcutId,
} from '@/shared/utils/app-shortcuts'
import { createDefaultEditorShortcutSettings } from '@/shared/utils/editor-shortcuts'

type ShortcutCategory = 'all' | 'workspace' | 'file' | 'heading' | 'menu' | 'modified'
type ShortcutTarget = 'headingLevelUp' | 'headingLevelDown' | AppShortcutId | number
type ShortcutRow = {
  target: ShortcutTarget | string
  command: string
  description: string
  scope: string
  category: Exclude<ShortcutCategory, 'all' | 'modified'>
  binding: EditorShortcutBinding | null
  shortcut: string
  editable: boolean
  configured: boolean
}

const settingsStore = useSettingsStore()
const workspaceStore = useWorkspaceStore()
const platform = window.electronAPI.platform
const formatShortcut = (shortcut: EditorShortcutBinding) => formatEditorShortcut(shortcut, platform)
const activePanel = ref<'menu' | 'shortcuts'>('shortcuts')
const activeShortcutCategory = ref<ShortcutCategory>('all')
const draggedInlineMenuIndex = ref<number | null>(null)
const recordingTarget = ref<ShortcutTarget | null>(null)
const shortcutError = ref('')

const currentInlineMenuActions = computed(() => resolveInlineMenuItems(settingsStore.inlineMenuItems))

const isInlineMenuActionAdded = (id: string) => settingsStore.inlineMenuItems.includes(id)
const targetKey = (target: ShortcutTarget | string) => typeof target === 'number' ? `menu-${target}` : target
const isSameTarget = (left: ShortcutTarget | string, right: ShortcutTarget | string) => targetKey(left) === targetKey(right)
const isEditableShortcutTarget = (target: ShortcutTarget | string): target is ShortcutTarget =>
  typeof target === 'number'
  || target === 'headingLevelUp'
  || target === 'headingLevelDown'
  || Object.prototype.hasOwnProperty.call(settingsStore.appShortcuts, target)
const isAppShortcutTarget = (target: ShortcutTarget): target is AppShortcutId =>
  typeof target === 'string'
  && target !== 'headingLevelUp'
  && target !== 'headingLevelDown'

const shortcutRows = computed<ShortcutRow[]>(() => {
  const shortcuts = settingsStore.editorShortcuts
  const menuActions = currentInlineMenuActions.value.slice(0, 9)
  return [
    ...getAppShortcutDefinitions(settingsStore.appShortcuts, platform).map((shortcut): ShortcutRow => ({
      target: shortcut.settingKey,
      command: shortcut.command,
      description: shortcut.description,
      scope: shortcut.scope,
      category: shortcut.category,
      binding: shortcut.binding,
      shortcut: shortcut.shortcut,
      editable: true,
      configured: true,
    })),
    {
      target: 'headingLevelUp',
      command: '提升标题级别',
      description: '正文 → H6 → … → H1，H1 保持不变',
      scope: '正文与标题段落',
      category: 'heading',
      binding: shortcuts.headingLevelUp,
      shortcut: formatShortcut(shortcuts.headingLevelUp),
      editable: true,
      configured: true,
    },
    {
      target: 'headingLevelDown',
      command: '降低标题级别',
      description: 'H1 → H2 → … → H6 → 正文',
      scope: '标题段落',
      category: 'heading',
      binding: shortcuts.headingLevelDown,
      shortcut: formatShortcut(shortcuts.headingLevelDown),
      editable: true,
      configured: true,
    },
    ...shortcuts.inlineMenuSlots.map((binding, index): ShortcutRow => {
      const action = menuActions[index]
      return {
        target: index,
        command: action ? `菜单第 ${index + 1} 项 · ${action.label}` : `菜单第 ${index + 1} 项 · 未配置`,
        description: action ? '操作名称跟随快速插入菜单排序自动更新' : '当前快速插入菜单没有此位置',
        scope: '编辑器',
        category: 'menu',
        binding,
        shortcut: formatShortcut(binding),
        editable: true,
        configured: Boolean(action),
      }
    }),
  ]
})

const defaultShortcutRows = computed(() => {
  const editorDefaults = createDefaultEditorShortcutSettings()
  const appDefaults = createDefaultAppShortcutSettings()
  return new Map<ShortcutTarget, EditorShortcutBinding>([
    ...(Object.entries(appDefaults) as Array<[AppShortcutId, EditorShortcutBinding]>),
    ['headingLevelUp', editorDefaults.headingLevelUp],
    ['headingLevelDown', editorDefaults.headingLevelDown],
    ...editorDefaults.inlineMenuSlots.map((binding, index) => [index, binding] as const),
  ])
})

const isRowModified = (row: ShortcutRow) => {
  if (!row.editable || !row.binding) return false
  if (!isEditableShortcutTarget(row.target)) return false
  const fallback = defaultShortcutRows.value.get(row.target)
  return Boolean(fallback)
    && (editorShortcutSignature(row.binding) !== editorShortcutSignature(fallback)
      || row.binding.enabled !== fallback.enabled)
}

const visibleShortcutRows = computed(() => shortcutRows.value.filter((row) => {
  if (activeShortcutCategory.value === 'all') return true
  if (activeShortcutCategory.value === 'modified') return isRowModified(row)
  return row.category === activeShortcutCategory.value
}))

const modifiedShortcutCount = computed(() => shortcutRows.value.filter(isRowModified).length)

const shortcutCategories = computed(() => [
  { id: 'all' as const, label: '全部快捷键', count: shortcutRows.value.length, icon: Keyboard },
  { id: 'workspace' as const, label: '工作空间', count: shortcutRows.value.filter(row => row.category === 'workspace').length, icon: Folders },
  { id: 'file' as const, label: '文件操作', count: shortcutRows.value.filter(row => row.category === 'file').length, icon: FileText },
  { id: 'heading' as const, label: '标题编辑', count: 2, icon: Heading },
  { id: 'menu' as const, label: '快速插入', count: shortcutRows.value.filter(row => row.category === 'menu').length, icon: ListTree },
  { id: 'modified' as const, label: '已修改', count: modifiedShortcutCount.value, icon: RotateCcw },
])

const moveInlineMenuItem = (toIndex: number) => {
  if (draggedInlineMenuIndex.value === null) return
  settingsStore.moveInlineMenuItem(draggedInlineMenuIndex.value, toIndex)
  draggedInlineMenuIndex.value = null
}

const findShortcutConflict = (target: ShortcutTarget, binding: EditorShortcutBinding) =>
  shortcutRows.value.find(row => row.binding && !isSameTarget(row.target, target)
    && editorShortcutSignature(row.binding) === editorShortcutSignature(binding))

const startRecording = (target: ShortcutTarget | string) => {
  if (!isEditableShortcutTarget(target)) return
  shortcutError.value = ''
  recordingTarget.value = target
}

const toggleShortcut = async (row: ShortcutRow) => {
  if (!row.editable || !row.binding || !isEditableShortcutTarget(row.target)) return
  if (isAppShortcutTarget(row.target)) return
  shortcutError.value = ''
  if (!row.binding.enabled) {
    const conflict = findShortcutConflict(row.target, row.binding)
    if (conflict?.binding.enabled) {
      shortcutError.value = `无法启用：${formatShortcut(row.binding)} 已用于“${conflict.command}”。`
      return
    }
  }
  await settingsStore.setEditorShortcut(row.target, {
    ...row.binding,
    enabled: !row.binding.enabled,
  })
}

const handleShortcutRecording = async (event: KeyboardEvent) => {
  const target = recordingTarget.value
  if (target === null) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (event.key === 'Escape') {
    recordingTarget.value = null
    shortcutError.value = ''
    return
  }

  const candidate = isAppShortcutTarget(target)
    ? appShortcutFromKeyboardEvent(event, platform)
    : shortcutFromKeyboardEvent(event, platform)
  if (!candidate) {
    shortcutError.value = isAppShortcutTarget(target)
      ? '请按下组合键，或 F1～F12、Delete、退格键等功能键；不能使用单个字符或仅修饰键。'
      : platform === 'darwin'
        ? '请按下包含 Command、Option 或 Control 的组合键；不能使用单个字符或仅修饰键。'
        : '请按下包含 Ctrl、Alt 或 Meta 的组合键；不能使用单个字符或仅修饰键。'
    return
  }
  const current = shortcutRows.value.find(row => isSameTarget(row.target, target))
  if (!current?.binding) return
  candidate.enabled = current.binding.enabled
  const conflict = findShortcutConflict(target, candidate)
  if (conflict) {
    shortcutError.value = `${formatShortcut(candidate)} 已用于“${conflict.command}”，请换一个组合键。`
    return
  }

  if (isAppShortcutTarget(target)) await settingsStore.setAppShortcut(target, candidate)
  else await settingsStore.setEditorShortcut(target, candidate)
  recordingTarget.value = null
  shortcutError.value = ''
}

const resetEditorShortcuts = async () => {
  const confirmed = await workspaceStore.requestConfirmation({
    title: '恢复默认快捷键？',
    message: '所有已修改的快捷键组合和启用状态都会恢复为默认设置。',
    confirmText: '恢复默认',
    cancelText: '取消',
  })
  if (!confirmed) return
  recordingTarget.value = null
  shortcutError.value = ''
  await settingsStore.resetEditorShortcuts()
}

onMounted(() => window.addEventListener('keydown', handleShortcutRecording, { capture: true }))
onBeforeUnmount(() => window.removeEventListener('keydown', handleShortcutRecording, { capture: true }))
</script>

<template>
  <div class="flex min-h-0 flex-col gap-4">
    <div class="flex shrink-0 items-center gap-5 border-b border-border-soft">
      <button
        type="button"
        class="border-b-2 px-0.5 pb-3 text-sm transition-colors"
        :class="activePanel === 'menu' ? 'border-accent font-medium text-text-main' : 'border-transparent text-text-muted hover:text-text-main'"
        @click="activePanel = 'menu'"
      >
        快速插入菜单
      </button>
      <button
        type="button"
        class="border-b-2 px-0.5 pb-3 text-sm transition-colors"
        :class="activePanel === 'shortcuts' ? 'border-accent font-medium text-text-main' : 'border-transparent text-text-muted hover:text-text-main'"
        @click="activePanel = 'shortcuts'"
      >
        快捷键中心
      </button>
    </div>

    <div v-if="activePanel === 'menu'" class="flex min-h-0 flex-col gap-4">
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
        class="grid min-h-0 w-max min-w-full grid-cols-2 gap-4"
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
      </div>
    </div>

    <div v-else class="flex min-h-0 flex-1 flex-col gap-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="mt-1 text-xs leading-5 text-text-muted">
            集中查看应用内全部快捷键。点击组合键即可修改；应用与文件操作命令始终启用，编辑器命令还可单独停用。冲突组合键不会覆盖原配置，按 Esc 可取消录入。
          </p>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-md border border-border-soft bg-panel-soft px-3 py-2 text-xs text-text-main transition-colors hover:bg-accent-soft"
          @click="resetEditorShortcuts"
        >
          <RotateCcw :size="14" />
          <span>恢复默认快捷键</span>
        </button>
      </div>

      <div
        v-if="shortcutError"
        class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-5 text-text-main"
        role="alert"
      >
        {{ shortcutError }}
      </div>

      <div class="grid min-h-[420px] overflow-hidden rounded-lg border border-border-soft lg:grid-cols-[150px_minmax(0,1fr)]">
        <nav class="flex gap-1 overflow-x-auto border-b border-border-soft bg-panel-soft p-2 lg:flex-col lg:border-b-0 lg:border-r">
          <button
            v-for="category in shortcutCategories"
            :key="category.id"
            type="button"
            class="flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition-colors lg:w-full"
            :class="activeShortcutCategory === category.id ? 'bg-panel text-text-main shadow-sm' : 'text-text-muted hover:bg-panel/70 hover:text-text-main'"
            @click="activeShortcutCategory = category.id"
          >
            <component :is="category.icon" :size="15" class="shrink-0" />
            <span class="min-w-0 flex-1">
              <span class="block whitespace-nowrap font-medium">{{ category.label }}</span>
              <span class="mt-0.5 block text-[10px] text-text-subtle">{{ category.count }} 个命令</span>
            </span>
          </button>
        </nav>

        <div class="min-w-0 overflow-auto p-3 lg:p-4">
          <div class="min-w-[360px] md:min-w-[560px]">
            <div class="hidden grid-cols-[minmax(180px,1fr)_100px_140px_54px] gap-3 px-3 pb-2 text-[10px] text-text-subtle md:grid">
              <span>命令</span>
              <span>作用范围</span>
              <span>快捷键</span>
              <span class="text-center">启用</span>
            </div>

            <div v-if="visibleShortcutRows.length" class="overflow-hidden rounded-lg border border-border-soft">
              <div
                v-for="row in visibleShortcutRows"
                :key="targetKey(row.target)"
                class="grid grid-cols-[minmax(120px,1fr)_112px_42px] items-center gap-3 border-b border-border-soft px-3 py-3 last:border-b-0 md:grid-cols-[minmax(180px,1fr)_100px_140px_54px]"
                :class="!row.configured ? 'bg-panel-soft/50' : 'bg-panel'"
              >
                <div class="min-w-0">
                  <div class="truncate text-xs font-medium" :class="row.configured ? 'text-text-main' : 'text-text-muted'">
                    {{ row.command }}
                  </div>
                  <div class="mt-1 truncate text-[10px] text-text-muted">{{ row.description }}</div>
                </div>
                <span class="hidden w-fit rounded bg-panel-soft px-2 py-1 text-[10px] text-text-muted md:inline-flex">
                  {{ row.scope }}
                </span>
                <button
                  v-if="row.editable"
                  type="button"
                  class="min-w-0 rounded-md border px-2 py-2 text-[10px] transition-colors"
                  :class="isSameTarget(recordingTarget ?? 'headingLevelUp', row.target) && recordingTarget !== null
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border-soft bg-panel-soft text-text-main hover:border-accent/60'"
                  :aria-label="`修改${row.command}快捷键`"
                  @click="startRecording(row.target)"
                >
                  <span class="block truncate">
                    {{ isSameTarget(recordingTarget ?? 'headingLevelUp', row.target) && recordingTarget !== null
                      ? '请按组合键…'
                      : row.shortcut }}
                  </span>
                </button>
                <span
                  v-else
                  class="block min-w-0 truncate rounded-md border border-border-soft bg-panel-soft px-2 py-2 text-center text-[10px] text-text-main"
                >
                  {{ row.shortcut }}
                </span>
                <button
                  v-if="row.editable && row.binding && isEditableShortcutTarget(row.target) && !isAppShortcutTarget(row.target)"
                  type="button"
                  class="relative mx-auto h-[18px] w-8 rounded-full transition-colors"
                  :class="row.binding.enabled ? 'bg-accent' : 'bg-text-subtle'"
                  :aria-label="`${row.binding.enabled ? '禁用' : '启用'}${row.command}`"
                  :aria-pressed="row.binding.enabled"
                  @click="toggleShortcut(row)"
                >
                  <span
                    class="absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-all"
                    :class="row.binding.enabled ? 'left-[17px]' : 'left-0.5'"
                  />
                </button>
                <span v-else class="text-center text-[10px] text-text-subtle">固定启用</span>
              </div>
            </div>

            <div
              v-else
              class="rounded-lg border border-dashed border-border-soft px-4 py-12 text-center text-xs text-text-muted"
            >
              当前分类没有已修改的快捷键。
            </div>
          </div>
        </div>
      </div>
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
