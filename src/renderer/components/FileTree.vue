<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
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
  if (!isFile) return path
  return path.split('/').slice(0, -1).join('/')
}

const getDisplayExt = (row: FsEntry) => {
  if (row.isDirectory) return ''
  const name = row.name || ''
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex === name.length - 1) return ''
  return name.slice(dotIndex)
}

const getDisplayName = (row: FsEntry) => {
  if (row.isDirectory) return row.name
  const ext = getDisplayExt(row)
  if (row.name.length === ext.length) return row.name
  return ext ? row.name.slice(0, -ext.length) : row.name
}

const shouldShowEntry = (entry: FsEntry) => entry.name === '.gitignore' || !entry.name.startsWith('.')

const isExpanded = (dirRelativePath: string) => expanded.value.has(dirRelativePath)
const toggle = async (dirRelativePath: string) => workspaceStore.toggleDirExpanded(dirRelativePath)

const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const selectedFile = ref<FsEntry | null>(null)

const closeMenu = () => {
  menuOpen.value = false
}

const openMenu = (event: MouseEvent, row: FsEntry) => {
  event.preventDefault()
  selectedFile.value = row
  const pad = 8
  const width = 180
  const height = 260
  menuX.value = Math.max(pad, Math.min(event.clientX, window.innerWidth - width - pad))
  menuY.value = Math.max(pad, Math.min(event.clientY, window.innerHeight - height - pad))
  menuOpen.value = true
}

const handleRowClick = (_event: MouseEvent, row: FsEntry, isMulti: boolean) => {
  workspaceStore.selectPath(row.relativePath, isMulti, false)
  if (isMulti) return

  if (row.isDirectory) {
    workspaceStore.selectDir(row.relativePath)
    workspaceStore.toggleDirExpanded(row.relativePath)
  } else {
    workspaceStore.setActiveFileRelative(row.relativePath)
  }
}

const handleRightClick = (event: MouseEvent, row: FsEntry) => {
  event.stopPropagation()
  workspaceStore.selectPath(row.relativePath, false, true)
  openMenu(event, row)
}

const addFile = async () => {
  closeMenu()
  await workspaceStore.createMarkdown(undefined, selectedFile.value?.relativePath)
}

const addFolder = async () => {
  closeMenu()
  await workspaceStore.createFolder(undefined, selectedFile.value?.relativePath)
}

const renameEntry = async (relativePath: string) => {
  await workspaceStore.renameEntry(relativePath)
  closeMenu()
}

const removeEntry = async (relativePath: string) => {
  if (workspaceStore.selectedPaths.includes(relativePath)) {
    await workspaceStore.deleteEntries(workspaceStore.selectedPaths)
  } else {
    await workspaceStore.deleteEntries([relativePath])
  }
  closeMenu()
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
  dragImage.textContent = pathsToDrag.length > 1 ? `Move ${pathsToDrag.length} items` : entry.name
  dragImage.className = 'bg-accent text-white px-3 py-1 rounded text-sm whitespace-nowrap fixed -top-[1000px]'
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
  } catch {
    const raw = event.dataTransfer?.getData('text/plain')
    if (raw) draggedPaths = [raw]
  }

  if (draggedPaths.length === 0) return
  const targetDir = await getParentDirFromPath(dirRelativePath)

  const toMove = draggedPaths.filter((from) => {
    if (!from || from === targetDir) return false
    const name = from.split('/').pop() || from
    const to = (targetDir ? `${targetDir}/${name}` : name).replace(/\/{2,}/g, '/')
    return to !== from
  })

  if (toMove.length > 0) {
    await workspaceStore.moveEntries(toMove, targetDir)
  }
}

const allowDrop = (event: DragEvent) => {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

const flattened = computed(() => {
  const result: Array<FsEntry & { depth: number }> = []

  const walk = (entries: FsEntry[], depth: number) => {
    for (const entry of entries.filter(shouldShowEntry)) {
      result.push({ ...entry, depth })
      if (entry.isDirectory && isExpanded(entry.relativePath)) {
        walk(getChildren(entry.relativePath), depth + 1)
      }
    }
  }

  walk(getChildren(''), 0)
  return result
})

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

const onGlobalPointerDown = () => closeMenu()
const onGlobalKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeMenu()
  if (e.key === 'Delete' && workspaceStore.selectedPaths.length > 0) {
    workspaceStore.deleteEntries(workspaceStore.selectedPaths)
  }
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
      @contextmenu.self="(e) => { workspaceStore.clearSelection(); openMenu(e, { name: '', relativePath: '', isDirectory: true, size: 0, mtimeMs: 0 }) }"
      @dragover.self="allowDrop"
      @drop.self="(e) => onDropToDir(e, '')"
    >
      <div v-if="flattened.length === 0" class="px-2 py-2 rounded-md text-sm text-text-subtle">
        空文件夹
      </div>

      <div
        v-for="row in flattened"
        :key="row.relativePath"
        class="group flex items-center gap-2 py-1.5 px-2 rounded-md border-l-2 border-transparent text-text-muted hover:bg-accent-soft hover:text-text-main"
        :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
        :class="[
          workspaceStore.selectedPaths.includes(row.relativePath) ? 'border-accent bg-accent-soft text-text-main' : '',
          (!workspaceStore.selectedPaths.includes(row.relativePath) && !row.isDirectory && activeFileRel === row.relativePath) ? 'border-accent bg-accent-soft text-text-main' : '',
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
          class="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-accent-soft text-text-muted"
          @click.stop="toggle(row.relativePath)"
        >
          <ChevronRight
            :size="14"
            :class="['transition-transform', isExpanded(row.relativePath) ? 'rotate-90' : 'rotate-0']"
          />
        </button>
        <div v-else class="w-6 h-6"></div>

        <div class="flex-1 min-w-0 text-left text-sm truncate select-none" :title="row.name">
          {{ getDisplayName(row) }}
        </div>
        <div
          v-if="getDisplayExt(row) && getDisplayExt(row) !== '.md'"
          class="shrink-0 rounded-md bg-panel-soft px-1.5 py-0.5 text-[11px] leading-4 text-text-muted select-none"
        >
          {{ getDisplayExt(row) }}
        </div>
      </div>

      <div
        v-if="menuOpen && selectedFile"
        class="fixed z-50 w-[180px] rounded-lg border border-border-soft bg-panel shadow-xl py-1 text-text-main"
        :style="{ left: `${menuX}px`, top: `${menuY}px` }"
        style="-webkit-app-region: no-drag"
        @pointerdown.stop
        @contextmenu.prevent
      >
        <button
          v-if="selectedFile.isDirectory"
          title="新建文件"
          class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft"
          @click="addFile"
        >
          新建文件
        </button>
        <button
          v-if="selectedFile.isDirectory"
          title="新建文件夹"
          class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft"
          @click="addFolder"
        >
          新建文件夹
        </button>
        <button
          v-if="workspaceStore.selectedPaths.length === 1"
          class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft"
          title="重命名"
          @click="renameEntry(workspaceStore.selectedPaths[0])"
        >
          重命名
        </button>
        <button
          v-if="selectedFile.relativePath !== ''"
          class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft"
          title="删除"
          @click="removeEntry(workspaceStore.selectedPaths[0])"
        >
          删除
        </button>
        <div v-if="selectedFile.relativePath !== ''" class="h-px bg-accent-soft my-1"></div>
        <button v-if="selectedFile.relativePath !== ''" class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft" @click="handleCopyPath">
          复制绝对路径
        </button>
        <button v-if="selectedFile.relativePath !== ''" class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft" @click="handleCopyRelativePath">
          复制相对路径
        </button>
        <div v-if="selectedFile.relativePath !== ''" class="h-px bg-accent-soft my-1"></div>
        <button v-if="selectedFile.relativePath !== ''" class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft" @click="handleRevealInExplorer">
          在文件资源管理器中显示
        </button>
      </div>
    </div>
  </div>
</template>
