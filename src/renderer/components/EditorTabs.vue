<script setup lang="ts">
import { useWorkspaceStore } from '../store/workspace'
import { X, CheckCircle2, AlertCircle } from 'lucide-vue-next'
import { computed, ref, onMounted, onUnmounted } from 'vue'

const workspaceStore = useWorkspaceStore()

const isSaving = computed(() => workspaceStore.activeFileIsSaving)
const saveError = computed(() => workspaceStore.activeFileSaveError || null)

const closeTab = (e: Event | null, relPath: string) => {
  if (e) e.stopPropagation()
  const idx = workspaceStore.openedFiles.indexOf(relPath)
  if (idx > -1) {
    workspaceStore.openedFiles.splice(idx, 1)
    workspaceStore.saveWorkspaceMeta().catch(() => {})
    
    if (workspaceStore.activeFileRelativePath === relPath) {
      // If we closed the active tab, switch to the adjacent one
      const nextTab = workspaceStore.openedFiles[idx] || workspaceStore.openedFiles[idx - 1]
      if (nextTab) {
        workspaceStore.setActiveFileRelative(nextTab)
      } else {
        workspaceStore.setActiveFileRelative('')
      }
    }
  }
}

const selectTab = (relPath: string) => {
  if (workspaceStore.activeFileRelativePath !== relPath) {
    workspaceStore.setActiveFileRelative(relPath)
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
  
  const items = [...workspaceStore.openedFiles]
  const [removed] = items.splice(draggedIndex, 1)
  items.splice(index, 0, removed)
  
  workspaceStore.openedFiles = items
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
const contextMenuTab = ref<string>('')

const closeMenu = () => {
  menuOpen.value = false
}

const onContextMenu = (event: MouseEvent, relPath: string) => {
  event.preventDefault()
  contextMenuTab.value = relPath
  const pad = 8
  const width = 180
  const height = 260
  const x = Math.min(event.clientX, window.innerWidth - width - pad)
  const y = Math.min(event.clientY, window.innerHeight - height - pad)
  menuX.value = Math.max(pad, x)
  menuY.value = Math.max(pad, y)
  menuOpen.value = true
}

const handleCloseTab = () => {
  if (!contextMenuTab.value) return
  closeTab(null, contextMenuTab.value)
  closeMenu()
}

const handleCloseRightTabs = () => {
  if (!contextMenuTab.value) return
  const idx = workspaceStore.openedFiles.indexOf(contextMenuTab.value)
  if (idx > -1) {
    const toRemove = workspaceStore.openedFiles.slice(idx + 1)
    if (toRemove.length > 0) {
      workspaceStore.openedFiles.splice(idx + 1)
      workspaceStore.saveWorkspaceMeta().catch(() => {})
      if (toRemove.includes(workspaceStore.activeFileRelativePath)) {
        workspaceStore.setActiveFileRelative(contextMenuTab.value)
      }
    }
  }
  closeMenu()
}

const handleCloseSavedTabs = () => {
  const activeUnsaved = workspaceStore.hasUnsavedChanges
  const activeRel = workspaceStore.activeFileRelativePath
  
  if (activeUnsaved && activeRel) {
    workspaceStore.openedFiles = [activeRel]
  } else {
    workspaceStore.openedFiles = []
    workspaceStore.setActiveFileRelative('')
  }
  workspaceStore.saveWorkspaceMeta().catch(() => {})
  closeMenu()
}

const handleCloseAllTabs = () => {
  workspaceStore.openedFiles = []
  workspaceStore.setActiveFileRelative('')
  workspaceStore.saveWorkspaceMeta().catch(() => {})
  closeMenu()
}

const handleCopyPath = () => {
  if (!contextMenuTab.value || !workspaceStore.activeWorkspace) return
  const wsPath = workspaceStore.activeWorkspace.path
  const sep = wsPath.includes('\\') ? '\\' : '/'
  const root = wsPath.endsWith(sep) ? wsPath.slice(0, -1) : wsPath
  const absPath = `${root}${sep}${contextMenuTab.value.split('/').join(sep)}`
  navigator.clipboard.writeText(absPath).catch(() => {})
  closeMenu()
}

const handleCopyRelativePath = () => {
  if (!contextMenuTab.value) return
  navigator.clipboard.writeText(contextMenuTab.value).catch(() => {})
  closeMenu()
}

const handleRevealInExplorer = async () => {
  if (!contextMenuTab.value || !workspaceStore.activeWorkspaceId) return
  await window.electronAPI.fs.showItemInFolder(workspaceStore.activeWorkspaceId, contextMenuTab.value)
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
  <header class="h-10 flex bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 z-10 w-full overflow-hidden select-none">
    <div 
      class="flex-1 flex overflow-x-auto overflow-y-hidden custom-scrollbar"
      @wheel="onWheel"
    >
      <div
        v-for="(relPath, index) in workspaceStore.openedFiles"
        :key="relPath"
        class="group flex items-center gap-2 px-3 min-w-[120px] max-w-[200px] h-full border-r border-zinc-200 dark:border-zinc-800 cursor-pointer relative shrink-0 transition-colors"
        :class="[
          workspaceStore.activeFileRelativePath === relPath
            ? 'bg-white dark:bg-[#1e1e1e] text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-500'
            : 'bg-zinc-50 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 border-t-2 border-t-transparent'
        ]"
        draggable="true"
        @dragstart="(e) => onDragStart(e, index)"
        @dragover="(e) => onDragOver(e, index)"
        @dragend="onDragEnd"
        @click="selectTab(relPath)"
        @contextmenu="(e) => onContextMenu(e, relPath)"
        :title="relPath"
      >
        <span class="text-xs truncate flex-1">{{ relPath.split('/').pop() }}</span>
        
        <!-- Save indicator dot (only for active tab if unsaved, but we don't track per-file unsaved state easily right now, so we use global isSaving for active tab) -->
        <div v-if="workspaceStore.activeFileRelativePath === relPath && workspaceStore.hasUnsavedChanges" class="w-2 h-2 rounded-full bg-zinc-400 group-hover:hidden"></div>

        <button
          class="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity"
          :class="{ 'opacity-100': workspaceStore.activeFileRelativePath === relPath && !workspaceStore.hasUnsavedChanges }"
          @click="(e) => closeTab(e, relPath)"
        >
          <X :size="12" />
        </button>
      </div>
    </div>

    <!-- Right side status -->
    <div class="flex items-center gap-2 px-4 shrink-0 border-l border-zinc-200 dark:border-zinc-800">
      <div v-if="isSaving" class="flex items-center gap-1.5 px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-[10px] text-zinc-500 font-medium">
        <div class="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse"></div>
        Saving...
      </div>
      <div v-else-if="!saveError && workspaceStore.activeFilePath" class="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-emerald-500 font-medium">
        <CheckCircle2 :size="12" />
        Saved
      </div>
      <div v-else-if="saveError" class="flex items-center gap-1 px-2 py-0.5 rounded bg-red-50 dark:bg-red-900/20 text-[10px] text-red-500 font-medium group cursor-pointer" :title="saveError">
        <AlertCircle :size="12" />
        Save Failed
      </div>
    </div>
    
    <!-- Context Menu -->
    <div
      v-if="menuOpen"
      class="fixed z-50 w-[180px] rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xl py-1 text-sm text-zinc-700 dark:text-zinc-300"
      :style="{ left: `${menuX}px`, top: `${menuY}px` }"
      style="-webkit-app-region: no-drag"
      @pointerdown.stop
      @contextmenu.prevent
    >
      <button class="w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="handleCloseTab">
        关闭
      </button>
      <button class="w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="handleCloseRightTabs">
        关闭右侧标签页
      </button>
      <button class="w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="handleCloseSavedTabs">
        关闭已保存
      </button>
      <button class="w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="handleCloseAllTabs">
        全部关闭
      </button>
      <div class="h-px bg-zinc-200 dark:bg-zinc-800 my-1"></div>
      <button class="w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="handleCopyPath">
        复制路径
      </button>
      <button class="w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="handleCopyRelativePath">
        复制相对路径
      </button>
      <div class="h-px bg-zinc-200 dark:bg-zinc-800 my-1"></div>
      <button class="w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="handleRevealInExplorer">
        在文件资源管理器中显示
      </button>
    </div>
  </header>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  height: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.3);
  border-radius: 2px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background-color: rgba(156, 163, 175, 0.5);
}
</style>
