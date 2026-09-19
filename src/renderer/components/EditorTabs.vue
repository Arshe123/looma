<script setup lang="ts">
import { useWorkspaceStore, type WorkspaceTab } from '../stores/workspace'
import { useExternalDocumentsStore } from '../stores/externalDocuments'
import { X, FileSymlink } from 'lucide-vue-next'
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { FILE_TREE_REVEAL_ACTIVE_FILE_EVENT } from '@/shared/utils/file-tree-utils'
import { closeDocumentTabs, type DocumentTabCloseMode } from '@/renderer/utils/document-tab-closing'
import { getTabTitle } from '@/renderer/stores/workspace-tab-utils'

const workspaceStore = useWorkspaceStore()
const externalDocuments = useExternalDocumentsStore()

const closeTab = async (e: Event | null, tabId: string) => {
  if (e) e.stopPropagation()
  await workspaceStore.closeTab(tabId)
}

const selectTab = (tab: WorkspaceTab) => {
  externalDocuments.activeId = null
  const wasActive = workspaceStore.activeTabId === tab.id
  if (!wasActive) {
    workspaceStore.activateTab(tab.id)
  }
  if (wasActive && tab.kind === 'file') {
    window.dispatchEvent(new CustomEvent(FILE_TREE_REVEAL_ACTIVE_FILE_EVENT))
  }
}

let draggedIndex = -1

const onDragStart = (e: DragEvent, index: number) => {
  draggedIndex = index
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
  }
}

const onDragOver = (e: DragEvent, index: number) => {
  e.preventDefault()
  if (draggedIndex === -1 || draggedIndex === index) return
  
  const items = [...workspaceStore.tabs]
  const [removed] = items.splice(draggedIndex, 1)
  items.splice(index, 0, removed)
  
  workspaceStore.setTabs(items, workspaceStore.activeTabId)
  draggedIndex = index
  workspaceStore.saveWorkspaceMeta().catch(() => {})
}

const onDragEnd = () => {
  draggedIndex = -1
}

const onWheel = (e: WheelEvent) => {
  if (e.deltaY !== 0 && e.deltaX === 0) {
    e.preventDefault()
    const container = e.currentTarget as HTMLElement
    container.scrollLeft += e.deltaY
  }
}

// Context Menu Logic
const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const contextMenuTabId = ref<string>('')
const contextMenuTab = computed(() => workspaceStore.tabs.find((tab) => tab.id === contextMenuTabId.value) || null)
const isContextMenuFileTab = computed(() => contextMenuTab.value?.kind === 'file')

const closeMenu = () => {
  menuOpen.value = false
}

const onContextMenu = (event: MouseEvent, tab: { id: string }) => {
  event.preventDefault()
  contextMenuTabId.value = tab.id
  const pad = 8
  const width = 180
  const height = 320
  const x = Math.min(event.clientX, window.innerWidth - width - pad)
  const y = Math.min(event.clientY, window.innerHeight - height - pad)
  menuX.value = Math.max(pad, x)
  menuY.value = Math.max(pad, y)
  menuOpen.value = true
}

const closeTabs = async (mode: DocumentTabCloseMode) => {
  await closeDocumentTabs([
    ...workspaceStore.tabs.map(tab => ({ id: tab.id, dirty: workspaceStore.isTabDirty(tab.id), close: () => workspaceStore.closeTab(tab.id) })),
    ...externalDocuments.documents.map(doc => ({ id: doc.id, dirty: externalDocuments.dirty(doc.id), close: () => externalDocuments.close(doc.id) })),
  ], contextMenuTabId.value, mode)
  closeMenu()
}
const handleCloseTab = () => closeTabs('one')

const handleCloseLeftTabs = () => closeTabs('left')

const handleCloseRightTabs = () => closeTabs('right')

const handleCloseOtherTabs = () => closeTabs('other')

const handleCloseSavedTabs = () => closeTabs('saved')

const handleCloseAllTabs = () => closeTabs('all')

const handleCopyPath = () => {
  const tab = contextMenuTab.value
  if (!tab || tab.kind !== 'file' || !workspaceStore.activeWorkspace) return
  const wsPath = workspaceStore.activeWorkspace.path
  const sep = wsPath.includes('\\') ? '\\' : '/'
  const root = wsPath.endsWith(sep) ? wsPath.slice(0, -1) : wsPath
  const absPath = `${root}${sep}${tab.relativePath.split('/').join(sep)}`
  navigator.clipboard.writeText(absPath).catch(() => {})
  closeMenu()
}

const handleCopyRelativePath = () => {
  const tab = contextMenuTab.value
  if (!tab || tab.kind !== 'file') return
  navigator.clipboard.writeText(tab.relativePath).catch(() => {})
  closeMenu()
}

const handleRevealInExplorer = async () => {
  const tab = contextMenuTab.value
  if (!tab || tab.kind !== 'file') return
  await workspaceStore.showItemInFolder(tab.relativePath)
  closeMenu()
}

const onGlobalPointerDown = () => closeMenu()
const onGlobalKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeMenu()
}

onMounted(() => {
  window.addEventListener('pointerdown', onGlobalPointerDown)
  window.addEventListener('keydown', onGlobalKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('pointerdown', onGlobalPointerDown)
  window.removeEventListener('keydown', onGlobalKeyDown)
})
</script>

<template>
  <header class="h-12 shrink-0 flex bg-panel z-10 w-full overflow-hidden select-none p-1.5">
    <div 
      class="flex-1 flex overflow-x-auto overflow-y-hidden custom-scrollbar focus-scrollbar"
      @wheel="onWheel"
    >
      <div
        v-for="(tab, index) in workspaceStore.tabs"
        :key="tab.id"
        class="group flex items-center gap-2 px-3 min-w-[120px] max-w-[200px] h-full cursor-pointer relative shrink-0 transition-colors rounded-lg mr-1"
        :class="[
          !externalDocuments.activeId && workspaceStore.activeTabId === tab.id
            ? 'bg-surface text-accent'
            : 'text-text-muted hover:bg-accent-soft'
        ]"
        draggable="true"
        @dragstart="(e) => onDragStart(e, index)"
        @dragover="(e) => onDragOver(e, index)"
        @dragend="onDragEnd"
        @click="selectTab(tab)"
        @dblclick="workspaceStore.retainTab(tab.id)"
        @contextmenu="(e) => onContextMenu(e, tab)"
        :title="(tab.kind === 'file' ? tab.relativePath : getTabTitle(tab)) + (workspaceStore.previewTabId === tab.id ? '（预览，双击保留）' : '')"
      >
        <span class="text-xs truncate flex-1" :class="{ italic: workspaceStore.previewTabId === tab.id }">{{ getTabTitle(tab) }}</span>
        
        <div v-if="workspaceStore.isTabDirty(tab.id)" class="w-2 h-2 rounded-full bg-text-subtle group-hover:hidden"></div>

        <button
          class="w-5 h-5 flex items-center justify-center rounded hover:bg-accent-soft opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          :class="{ 'opacity-100': workspaceStore.activeTabId === tab.id && !workspaceStore.isTabDirty(tab.id) }"
          @click="(e) => closeTab(e, tab.id)"
          @dblclick.stop
        >
          <X :size="12" />
        </button>
      </div>
      <div v-for="doc in externalDocuments.documents" :key="doc.id" :title="doc.filePath"
        class="external-document-tab group flex items-center gap-2 px-3 min-w-[150px] max-w-[240px] shrink-0 rounded-lg mr-1 border border-accent/30 cursor-pointer"
        :class="externalDocuments.activeId === doc.id ? 'bg-accent-soft text-accent' : 'text-text-muted'"
        @click="externalDocuments.activeId = doc.id"
        @contextmenu="(e) => onContextMenu(e, doc)">
        <FileSymlink :size="14" class="shrink-0" />
        <span class="text-[10px] border border-current rounded px-1">外部</span>
        <span class="text-xs truncate">{{ doc.filePath.split(/[\\/]/).pop() }}</span>
        <span v-if="externalDocuments.dirty(doc.id)" class="w-2 h-2 shrink-0 rounded-full bg-text-subtle" aria-label="未保存" />
        <button class="p-1 shrink-0 hover:bg-surface rounded" title="关闭外部文件" @click.stop="externalDocuments.close(doc.id)"><X :size="12" /></button>
      </div>
    </div>
    
    <!-- Context Menu -->
    <div
      v-if="menuOpen"
      class="fixed z-50 w-[180px] rounded-lg border border-border-soft bg-panel shadow-xl py-1 text-sm text-text-main"
      :style="{ left: `${menuX}px`, top: `${menuY}px` }"
      style="-webkit-app-region: no-drag"
      @pointerdown.stop
      @contextmenu.prevent
    >
      <button class="w-full px-3 py-1.5 text-left hover:bg-accent-soft cursor-pointer" @click="handleCloseTab">
        关闭
      </button>
      <button class="w-full px-3 py-1.5 text-left hover:bg-accent-soft cursor-pointer" @click="handleCloseLeftTabs">
        关闭左侧标签页
      </button>
      <button class="w-full px-3 py-1.5 text-left hover:bg-accent-soft cursor-pointer" @click="handleCloseRightTabs">
        关闭右侧标签页
      </button>
      <button class="w-full px-3 py-1.5 text-left hover:bg-accent-soft cursor-pointer" @click="handleCloseOtherTabs">
        关闭其他标签页
      </button>
      <button class="w-full px-3 py-1.5 text-left hover:bg-accent-soft cursor-pointer" @click="handleCloseSavedTabs">
        关闭已保存标签页
      </button>
      <button class="w-full px-3 py-1.5 text-left hover:bg-accent-soft cursor-pointer" @click="handleCloseAllTabs">
        关闭全部标签页
      </button>
      <template v-if="isContextMenuFileTab">
        <div class="h-px bg-accent-soft my-1"></div>
        <button class="w-full px-3 py-1.5 text-left hover:bg-accent-soft cursor-pointer" @click="handleCopyPath">
          复制路径
        </button>
        <button class="w-full px-3 py-1.5 text-left hover:bg-accent-soft cursor-pointer" @click="handleCopyRelativePath">
          复制相对路径
        </button>
        <div class="h-px bg-accent-soft my-1"></div>
        <button class="w-full px-3 py-1.5 text-left hover:bg-accent-soft cursor-pointer" @click="handleRevealInExplorer">
          在文件资源管理器中显示
        </button>
      </template>
    </div>
  </header>
</template>

<style scoped>
.italic {
  font-synthesis: style;
}

.custom-scrollbar::-webkit-scrollbar {
  height: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: transparent;
  border-radius: 2px;
}
.custom-scrollbar:hover::-webkit-scrollbar-thumb,
.custom-scrollbar:focus-within::-webkit-scrollbar-thumb,
.custom-scrollbar:active::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.3);
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background-color: rgba(156, 163, 175, 0.5);
}
</style>
