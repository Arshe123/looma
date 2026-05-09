<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ChevronRight, Folder, FileText, Image, Video, FileType2 } from 'lucide-vue-next'
import { useWorkspaceStore, type FsEntry } from '../store/workspace'

const workspaceStore = useWorkspaceStore()

const expanded = computed(() => workspaceStore.activeExpandedSet)
const activeFileRel = computed(() => workspaceStore.activeFileRelativePath)

const getChildren = (dirRelativePath: string) => {
  const key = workspaceStore.keyOfDir(dirRelativePath)
  return workspaceStore.dirEntries[key] || []
}

const getParentDirFromPath = async (path: string) => {
  const isFile = await workspaceStore.isFile(path)
  if (!isFile) return path;
  return path.split('/').slice(0, -1).join('/')
}

const isExpanded = (dirRelativePath: string) => expanded.value.has(dirRelativePath)

const getIconForFile = (filename: string) => {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'md') return FileText
  if (ext === 'txt') return FileType2
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext || '')) return Image
  if (['mp4', 'webm', 'ogg'].includes(ext || '')) return Video
  return FileText
}

const toggle = async (dirRelativePath: string) => {
  await workspaceStore.toggleDirExpanded(dirRelativePath)
}

const removeEntry = async (relativePath: string) => {
  if (workspaceStore.selectedPaths.includes(relativePath)) {
    await workspaceStore.deleteEntries(workspaceStore.selectedPaths)
  } else {
    await workspaceStore.deleteEntries([relativePath])
  }
  closeMenu()
}

const renameEntry = async (relativePath: string) => {
  await workspaceStore.renameEntry(relativePath)
}

const handleRowClick = (event: MouseEvent, row: FsEntry, isMulti: boolean) => {
  workspaceStore.selectPath(row.relativePath, isMulti, false)

  if (!isMulti) {
    if (row.isDirectory) {
      workspaceStore.selectDir(row.relativePath)
      workspaceStore.toggleDirExpanded(row.relativePath)
    } else {
      workspaceStore.setActiveFileRelative(row.relativePath)
    }
  }
}

const handleRightClick = (event: MouseEvent, row: FsEntry) => {
  event.stopPropagation()
  workspaceStore.selectPath(row.relativePath, false, true)
  openMenu(event, row)
}

const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const selectedFile = ref<FsEntry>()

const closeMenu = () => {
  menuOpen.value = false
}

const openMenu = (event: MouseEvent, row: FsEntry) => {
  event.preventDefault()
  selectedFile.value = row
  const pad = 8
  const width = 180
  const height = 220
  const x = Math.min(event.clientX, window.innerWidth - width - pad)
  const y = Math.min(event.clientY, window.innerHeight - height - pad)
  menuX.value = Math.max(pad, x)
  menuY.value = Math.max(pad, y)
  menuOpen.value = true
}

const addFile = async () => {
  closeMenu()
  await workspaceStore.createMarkdown(undefined, selectedFile.value?.relativePath)
}

const addFolder = async () => {
  closeMenu()
  await workspaceStore.createFolder(undefined, selectedFile.value?.relativePath)
}

const onDragStart = (event: DragEvent, entry: FsEntry) => {
  let pathsToDrag = [entry.relativePath]
  if (workspaceStore.selectedPaths.includes(entry.relativePath)) {
    pathsToDrag = [...workspaceStore.selectedPaths]
  } else {
    workspaceStore.selectPath(entry.relativePath, false, false)
  }
  
  event.dataTransfer?.setData('text/plain', JSON.stringify(pathsToDrag))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  
  const dragImage = document.createElement('div')
  dragImage.textContent = pathsToDrag.length > 1 ? `移动 ${pathsToDrag.length} 个项目` : entry.name
  dragImage.className = 'bg-blue-500 text-white px-3 py-1 rounded text-sm whitespace-nowrap fixed -top-[1000px]'
  document.body.appendChild(dragImage)
  event.dataTransfer?.setDragImage(dragImage, 10, 10)
  setTimeout(() => document.body.removeChild(dragImage), 0)
}

const onDropToDir = async (event: DragEvent, dirRelativePath: string) => {
  event.preventDefault()
  
  let draggedPaths: string[] = []
  try {
    const data = event.dataTransfer?.getData('text/plain')
    if (data) {
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed)) draggedPaths = parsed
    }
  } catch (e) {
    const raw = event.dataTransfer?.getData('text/plain')
    if (raw) draggedPaths = [raw]
  }
  
  if (draggedPaths.length === 0) return

  dirRelativePath = await getParentDirFromPath(dirRelativePath)
  
  const toMove = draggedPaths.filter(from => {
    if (!from || from === dirRelativePath) return false
    const name = from.split('/').pop() || from
    const to = (dirRelativePath ? `${dirRelativePath}/${name}` : name).replace(/\/{2,}/g, '/')
    if (to === from) return false
    return true
  })
  
  if (toMove.length > 0) {
    await workspaceStore.moveEntries(toMove, dirRelativePath)
  }
}

const allowDrop = (event: DragEvent) => {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

const renderEntries = (entries: FsEntry[], depth: number) => {
  return entries.map((e) => ({ ...e, depth }))
}

const flattened = computed(() => {
  const rootChildren = getChildren('')
  const result: Array<FsEntry & { depth: number }> = []

  const walk = (dir: string, depth: number) => {
    const children = getChildren(dir)
    const rows = renderEntries(children, depth)
    for (const row of rows) {
      result.push(row)
      if (row.isDirectory && isExpanded(row.relativePath)) {
        walk(row.relativePath, depth + 1)
      }
    }
  }

  for (const row of renderEntries(rootChildren, 0)) {
    result.push(row)
    if (row.isDirectory && isExpanded(row.relativePath)) {
      walk(row.relativePath, 1)
    }
  }

  return result
})

const onGlobalPointerDown = () => closeMenu()
const onGlobalKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeMenu()
  if (e.key === 'Delete') {
    const paths = workspaceStore.selectedPaths
    if (paths.length > 0) {
      workspaceStore.deleteEntries(paths)
    }
  }
}

const handleCopyPath = () => {
  if (!selectedFile.value || !workspaceStore.activeWorkspace) return
  const wsPath = workspaceStore.activeWorkspace.path
  const sep = wsPath.includes('\\') ? '\\' : '/'
  const root = wsPath.endsWith(sep) ? wsPath.slice(0, -1) : wsPath
  const absPath = `${root}${sep}${selectedFile.value.relativePath.split('/').join(sep)}`
  navigator.clipboard.writeText(absPath).catch(() => {})
  closeMenu()
}

const handleCopyRelativePath = () => {
  if (!selectedFile.value) return
  navigator.clipboard.writeText(selectedFile.value.relativePath).catch(() => {})
  closeMenu()
}

const handleRevealInExplorer = async () => {
  if (!selectedFile.value) return
  await workspaceStore.showItemInFolder(selectedFile.value.relativePath)
  closeMenu()
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
  <div class="h-full flex flex-col">
    <div
      class="flex-1 overflow-y-auto px-2 pb-2 focus-scrollbar"
      @click.self="workspaceStore.clearSelection()"
      @contextmenu.self="(e) => { workspaceStore.clearSelection(); openMenu(e, { name: '', relativePath: '', isDirectory: true, size: 0, mtimeMs: 0})}"
      @dragover.self="allowDrop"
      @drop.self="(e) => onDropToDir(e, '')"
    >
      <div
        class="px-2 py-2 rounded-md text-sm text-zinc-500 dark:text-zinc-500"
        v-if="flattened.length === 0"
      >
        空文件夹
      </div>

      <div
        v-for="row in flattened"
        :key="row.relativePath"
        class="group flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800"
        :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
        :class="[
          workspaceStore.selectedPaths.includes(row.relativePath) ? 'bg-blue-100/50 dark:bg-blue-900/30' : '',
          (!workspaceStore.selectedPaths.includes(row.relativePath) && !row.isDirectory && activeFileRel === row.relativePath) ? 'bg-zinc-100 dark:bg-zinc-800' : '',
        ]"
        draggable="true"
        @dragstart="(e) => onDragStart(e, row)"
        @click.exact="handleRowClick($event, row, false)"
        @click.ctrl.exact="handleRowClick($event, row, true)"
        @click.meta.exact="handleRowClick($event, row, true)"
        @contextmenu="(e) => handleRightClick(e, row)"
        @dragover.capture="allowDrop"
        @drop.capture.stop="(e) => onDropToDir(e, row.relativePath)"
      >
        <button
          v-if="row.isDirectory"
          class="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500"
          @click.stop="toggle(row.relativePath)"
        >
          <ChevronRight
            :size="14"
            :class="['transition-transform', isExpanded(row.relativePath) ? 'rotate-90' : 'rotate-0']"
          />
        </button>
        <div v-else class="w-6 h-6"></div>

        <Folder v-if="row.isDirectory" :size="16" class="text-blue-500 shrink-0" />
        <component v-else :is="getIconForFile(row.name)" :size="16" class="text-zinc-400 shrink-0" />

        <div
          class="flex-1 min-w-0 text-left text-sm truncate select-none"
          :title="row.name"
        >
          {{ row.name }}
        </div>
      </div>

      <div
        v-if="menuOpen"
        class="fixed z-50 w-[180px] rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xl py-1"
        :style="{ left: `${menuX}px`, top: `${menuY}px` }"
        style="-webkit-app-region: no-drag"
        @pointerdown.stop
        @contextmenu.prevent
      >
        <button
          v-if="selectedFile.isDirectory"
          title="新建文件"
          class="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          @click="addFile"
        >
          新建文件
        </button>
        <button
          v-if="selectedFile.isDirectory"
          title="新建文件夹"
          class="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          @click="addFolder"
        >
          新建文件夹
        </button>
        <button
          v-if="workspaceStore.selectedPaths.length === 1"
          class="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          @click="renameEntry(workspaceStore.selectedPaths[0])"
          title="重命名"
        >
          <span>重命名</span>
        </button>

        <button
          v-if="selectedFile.relativePath !== ''"
          class="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          @click="removeEntry(workspaceStore.selectedPaths[0])"
          title="删除"
        >
          <span>删除</span>
        </button>
        <div class="h-px bg-zinc-200 dark:bg-zinc-800 my-1" v-if="selectedFile.relativePath !== ''"></div>
        <button v-if="selectedFile.relativePath !== ''" class="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="handleCopyPath">
          复制路径
        </button>
        <button v-if="selectedFile.relativePath !== ''" class="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="handleCopyRelativePath">
          复制相对路径
        </button>
        <div class="h-px bg-zinc-200 dark:bg-zinc-800 my-1" v-if="selectedFile.relativePath !== ''"></div>
        <button v-if="selectedFile.relativePath !== ''" class="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="handleRevealInExplorer">
          在文件资源管理器中显示
        </button>
      </div>
    </div>
  </div>
</template>
