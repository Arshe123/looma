<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ChevronRight, FileText, Folder, Hash, LoaderCircle } from 'lucide-vue-next'
import { useWorkspaceStore, type FsEntry } from '@/renderer/stores/workspace'
import { buildBreadcrumbs, useBreadcrumbNavigation } from '@/renderer/composables/breadcrumb-navigation'
import { EDITOR_FOCUS_EVENT } from '@/shared/utils/editor-focus'

const workspaceStore = useWorkspaceStore()
const currentFile = computed(() => workspaceStore.activeFileTab?.relativePath || '')
const root = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const menuStyle = ref({ left: '12px', bottom: '40px', width: '288px', maxHeight: '360px' })
const {
  browsingPath, entries, loading, focusLabel, browse, choose, cancel, updateFocus,
} = useBreadcrumbNavigation({
  workspaceId: () => workspaceStore.activeWorkspaceId,
  currentFile: () => currentFile.value,
  // Browsing is read-only: do not select/expand the file tree or change the active note.
  listDirectory: async (workspaceId, relativePath) => {
    const result = await window.electronAPI.fs.listDir(workspaceId, relativePath || '.')
    if (!result.success || !result.data) throw new Error(result.error || '目录读取失败')
    return result.data
  },
  openFile: (relativePath) => workspaceStore.openFileTab(relativePath),
  onError: (message) => workspaceStore.setError(message),
})
const crumbs = computed(() => buildBreadcrumbs(
  workspaceStore.activeWorkspace?.name || '工作空间',
  browsingPath.value ?? currentFile.value,
  browsingPath.value !== null,
))
const visibleEntries = computed(() => {
  const visible = entries.value.filter(entry => entry.name === '.gitignore' || !entry.name.startsWith('.'))
  if (workspaceStore.fileSortMode === 'name') return visible
  const direction = workspaceStore.fileSortMode === 'created-asc' ? 1 : -1
  const createdAt = (entry: FsEntry) => workspaceStore.fileCreationTimes[entry.relativePath]
    ?? entry.createdAtMs ?? entry.birthtimeMs ?? 0
  return visible.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory)
    || direction * (createdAt(a) - createdAt(b)))
})
const menuOpen = computed(() => browsingPath.value !== null && !loading.value && visibleEntries.value.length > 0)

const selectedButton = () => Array.from(root.value?.querySelectorAll<HTMLButtonElement>('[data-breadcrumb-path]') || [])
  .find(button => button.dataset.breadcrumbPath === browsingPath.value)
const positionMenu = () => {
  const rect = selectedButton()?.getBoundingClientRect()
  if (!rect) return
  const width = Math.min(288, window.innerWidth - 16)
  menuStyle.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
    bottom: `${window.innerHeight - rect.top + 6}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(0, Math.min(360, rect.top - 14))}px`,
  }
}
const revealEnd = async () => {
  await nextTick()
  root.value?.lastElementChild?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  positionMenu()
}
watch([crumbs, focusLabel], revealEnd, { flush: 'post' })
watch(menuOpen, async () => { await nextTick(); positionMenu() })
watch(() => workspaceStore.activeTabId, cancel, { flush: 'sync' })

const browseFolder = async (relativePath: string, keyboard = false) => {
  const request = browse(relativePath)
  await revealEnd()
  await request
  if (browsingPath.value !== relativePath) return
  await nextTick()
  positionMenu()
  if (keyboard) (menu.value?.querySelector<HTMLButtonElement>('button') || selectedButton())?.focus()
}
const chooseEntry = async (entry: FsEntry, event: MouseEvent) => {
  if (entry.isDirectory) await browseFolder(entry.relativePath, event.detail === 0)
  else await choose(entry)
}
const handleEditorFocus = (event: Event) => {
  const detail = (event as CustomEvent<{ relativePath: string; label: string }>).detail
  if (detail && typeof detail.relativePath === 'string' && typeof detail.label === 'string') updateFocus(detail)
}
const isInside = (target: EventTarget | null) => target instanceof Node
  && (root.value?.contains(target) || menu.value?.contains(target))
const handleOutsidePointer = (event: PointerEvent) => {
  if (!isInside(event.target)) cancel()
}
const handleKeyDown = (event: KeyboardEvent) => {
  if (browsingPath.value === null) return
  if (event.key === 'Escape') {
    const path = browsingPath.value
    cancel()
    void nextTick(() => {
      if (browsingPath.value !== null) return
      const ancestors = Array.from(root.value?.querySelectorAll<HTMLButtonElement>('[data-breadcrumb-path]') || [])
      ancestors.reverse().find(button => {
        const candidate = button.dataset.breadcrumbPath || ''
        return !candidate || path === candidate || path.startsWith(`${candidate}/`)
      })?.focus()
    })
    event.preventDefault()
    event.stopPropagation()
    return
  }
  if (!isInside(event.target)) return
  const buttons = Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('button') || [])
  if (!buttons.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : event.key === 'ArrowDown' ? (index + 1) % buttons.length : index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length
  buttons[next]?.focus()
  event.preventDefault()
  event.stopPropagation()
}
onMounted(() => {
  window.addEventListener(EDITOR_FOCUS_EVENT, handleEditorFocus)
  document.addEventListener('pointerdown', handleOutsidePointer, true)
  document.addEventListener('keydown', handleKeyDown, true)
  window.addEventListener('resize', positionMenu)
  window.addEventListener('blur', cancel)
})
onUnmounted(() => {
  window.removeEventListener(EDITOR_FOCUS_EVENT, handleEditorFocus)
  document.removeEventListener('pointerdown', handleOutsidePointer, true)
  document.removeEventListener('keydown', handleKeyDown, true)
  window.removeEventListener('resize', positionMenu)
  window.removeEventListener('blur', cancel)
})
</script>

<template>
  <nav
    v-if="workspaceStore.activeWorkspace"
    ref="root"
    class="breadcrumb-navigation"
    aria-label="当前位置"
    @scroll="positionMenu"
  >
    <template v-for="(crumb, index) in crumbs" :key="crumb.relativePath">
      <ChevronRight v-if="index" :size="12" class="breadcrumb-separator" aria-hidden="true" />
      <button
        class="breadcrumb-item"
        :class="{ 'is-browsing': browsingPath === crumb.relativePath }"
        :data-breadcrumb-path="crumb.relativePath"
        :title="crumb.name"
        :aria-haspopup="crumb.isDirectory ? 'menu' : undefined"
        :aria-expanded="crumb.isDirectory ? browsingPath === crumb.relativePath : undefined"
        :aria-current="!crumb.isDirectory ? 'page' : undefined"
        :aria-busy="browsingPath === crumb.relativePath && loading"
        @click="crumb.isDirectory ? browseFolder(crumb.relativePath, $event.detail === 0) : cancel()"
        @keydown.down.prevent="crumb.isDirectory && browseFolder(crumb.relativePath, true)"
        @keydown.up.prevent="crumb.isDirectory && browseFolder(crumb.relativePath, true)"
      >
        <LoaderCircle v-if="loading && browsingPath === crumb.relativePath" :size="13" class="animate-spin shrink-0" aria-label="正在读取目录" />
        <component :is="crumb.isDirectory ? Folder : FileText" v-else :size="13" class="shrink-0" aria-hidden="true" />
        <span class="breadcrumb-name">{{ crumb.name }}</span>
      </button>
    </template>
    <template v-if="browsingPath === null && currentFile && focusLabel">
      <ChevronRight :size="12" class="breadcrumb-separator" aria-hidden="true" />
      <span class="breadcrumb-focus" :title="focusLabel"><Hash :size="12" class="shrink-0" aria-hidden="true" /><span>{{ focusLabel }}</span></span>
    </template>
  </nav>
  <div v-else class="flex-1" />
  <Teleport to="body">
    <div v-if="menuOpen" ref="menu" class="breadcrumb-menu" :style="menuStyle" role="menu" aria-label="目录选择">
      <button
        v-for="entry in visibleEntries"
        :key="entry.relativePath"
        class="breadcrumb-entry"
        :data-entry-path="entry.relativePath"
        :title="entry.name"
        role="menuitem"
        @click="chooseEntry(entry, $event)"
      >
        <component :is="entry.isDirectory ? Folder : FileText" :size="15" class="shrink-0 text-text-subtle" aria-hidden="true" />
        <span>{{ entry.name }}</span>
        <ChevronRight v-if="entry.isDirectory" :size="13" class="ml-auto shrink-0 text-text-subtle" aria-hidden="true" />
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.breadcrumb-navigation { display: flex; flex: 1; min-width: 0; align-items: center; overflow-x: auto; white-space: nowrap; scrollbar-width: none; gap: 1px; }
.breadcrumb-navigation::-webkit-scrollbar { display: none; }
.breadcrumb-item { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; height: 27px; max-width: 220px; padding: 0 7px; border-radius: 5px; color: var(--text-muted); font-size: 12px; cursor: pointer; }
.breadcrumb-item:hover, .breadcrumb-item.is-browsing { color: var(--accent); background: var(--accent-soft); }
.breadcrumb-name { overflow: hidden; text-overflow: ellipsis; }
.breadcrumb-separator { flex-shrink: 0; color: var(--text-subtle); }
.breadcrumb-focus { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; max-width: 230px; padding: 0 7px; font-size: 12px; color: var(--text-muted); }
.breadcrumb-focus span { overflow: hidden; text-overflow: ellipsis; }
.breadcrumb-menu { position: fixed; z-index: 60; overflow-y: auto; padding: 5px; border: 1px solid var(--border-soft); border-radius: 9px; background: var(--surface); color: var(--text-main); box-shadow: 0 8px 30px rgb(0 0 0 / 0.16); }
.breadcrumb-entry { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 34px; padding: 7px 9px; border-radius: 5px; text-align: left; font-size: 12px; cursor: pointer; }
.breadcrumb-entry > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.breadcrumb-entry:hover, .breadcrumb-entry:focus-visible { background: var(--accent-soft); color: var(--accent); }
.breadcrumb-item:focus-visible, .breadcrumb-entry:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
