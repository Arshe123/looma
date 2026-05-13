<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { useWorkspaceStore, type FsEntry } from '../store/workspace'
import {
  FILE_TREE_CREATE_FILE_EVENT,
  INLINE_MARKDOWN_FILENAME,
  buildCreateMarkdownName,
  buildRenameName,
  getCreateTargetDir,
  getEntryDisplayExt,
  getEntryDisplayName,
  getRenameInputName,
} from './util/file-tree-utils'
import { handleFileTreeGlobalKeyDown } from './util/file-tree-shortcuts'

const workspaceStore = useWorkspaceStore()
const expanded = computed(() => workspaceStore.activeExpandedSet)
const activeFileRel = computed(() => workspaceStore.activeFileRelativePath)

type InlineEditMode = 'create-file' | 'create-folder' | 'rename'
type InlineEditState = {
  mode: InlineEditMode
  parentDir: string
  targetPath: string
  targetName?: string
  targetIsDirectory?: boolean
  value: string
}
type FlatEntryRow = { kind: 'entry'; key: string; entry: FsEntry; depth: number }
type FlatInlineCreateRow = { kind: 'inline-create'; key: string; depth: number; parentDir: string }
type FlatRow = FlatEntryRow | FlatInlineCreateRow

const getChildren = (dirRelativePath: string) => {
  const key = workspaceStore.keyOfDir(dirRelativePath)
  return workspaceStore.dirEntries[key] || []
}

const getParentDirFromPath = async (path: string) => {
  const isFile = await workspaceStore.isFile(path)
  if (!isFile) return path
  return path.split('/').slice(0, -1).join('/')
}

const shouldShowEntry = (entry: FsEntry) => entry.name === '.gitignore' || !entry.name.startsWith('.')

const isExpanded = (dirRelativePath: string) => expanded.value.has(dirRelativePath)
const toggle = async (dirRelativePath: string) => workspaceStore.toggleDirExpanded(dirRelativePath)

const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const selectedFile = ref<FsEntry | null>(null)
const inlineEdit = ref<InlineEditState | null>(null)
const inlineInput = ref<HTMLInputElement | null>(null)

const inlineEditValue = computed({
  get: () => inlineEdit.value?.value ?? '',
  set: (value: string) => {
    if (inlineEdit.value) inlineEdit.value.value = value
  },
})

const setInlineInput = (el: Element | null) => {
  inlineInput.value = el instanceof HTMLInputElement ? el : null
}

const closeMenu = () => {
  menuOpen.value = false
}

const openMenu = (event: MouseEvent, row: FsEntry) => {
  event.preventDefault()
  selectedFile.value = row
  const pad = 8
  const width = 180
  const height = 320
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

const focusInlineInput = async () => {
  await nextTick()
  inlineInput.value?.focus()
  inlineInput.value?.select()
}

const ensureDirExpanded = async (dirRelativePath: string) => {
  if (!dirRelativePath) return
  if (!isExpanded(dirRelativePath)) {
    await workspaceStore.toggleDirExpanded(dirRelativePath)
  } else if (workspaceStore.activeWorkspaceId && !workspaceStore.dirEntries[workspaceStore.keyOfDir(dirRelativePath)]) {
    await workspaceStore.loadDir(workspaceStore.activeWorkspaceId, dirRelativePath)
  }
}

const startCreateFileInDir = async (parentDir: string) => {
  await ensureDirExpanded(parentDir)
  inlineEdit.value = { mode: 'create-file', parentDir, targetPath: '', value: INLINE_MARKDOWN_FILENAME }
  await focusInlineInput()
}

const startCreateFile = async (entry: FsEntry | null) => {
  closeMenu()
  await startCreateFileInDir(getCreateTargetDir(entry))
}

const startCreateFileFromCurrentDir = async () => {
  closeMenu()
  await startCreateFileInDir(workspaceStore.getCurrentDir())
}

const startCreateFolder = async (entry: FsEntry | null) => {
  closeMenu()
  const parentDir = getCreateTargetDir(entry)
  await ensureDirExpanded(parentDir)
  inlineEdit.value = { mode: 'create-folder', parentDir, targetPath: '', value: 'New Folder' }
  await focusInlineInput()
}

const pathBaseName = (relativePath: string) => relativePath.split('/').filter(Boolean).pop() || relativePath

const startRename = async (relativePath: string) => {
  closeMenu()
  const row = flattened.value.find((item): item is FlatEntryRow => item.kind === 'entry' && item.entry.relativePath === relativePath)
  const fallbackEntry = {
    name: pathBaseName(relativePath),
    isDirectory: Boolean(workspaceStore.dirEntries[workspaceStore.keyOfDir(relativePath)]),
  }
  const entry = row?.entry || fallbackEntry
  inlineEdit.value = {
    mode: 'rename',
    parentDir: row ? getCreateTargetDir(row.entry) : '',
    targetPath: relativePath,
    targetName: entry.name,
    targetIsDirectory: entry.isDirectory,
    value: getRenameInputName(entry),
  }
  await focusInlineInput()
}

const cancelInlineEdit = () => {
  inlineEdit.value = null
}

const submitInlineEdit = async () => {
  const edit = inlineEdit.value
  if (!edit) return

  inlineEdit.value = null
  const value = edit.value.trim()
  if (!value) return

  if (edit.mode === 'rename') {
    const entry = {
      name: edit.targetName || pathBaseName(edit.targetPath),
      isDirectory: Boolean(edit.targetIsDirectory),
    }
    const nextName = buildRenameName(entry, value)
    if (nextName === entry.name) return
    await workspaceStore.renameEntry(edit.targetPath, nextName)
  } else if (edit.mode === 'create-file') {
    await workspaceStore.createMarkdown(buildCreateMarkdownName(value), edit.parentDir)
  } else {
    await workspaceStore.createFolder(value, edit.parentDir)
  }
}

const addFile = async () => {
  await startCreateFile(selectedFile.value)
}

const addFolder = async () => {
  await startCreateFolder(selectedFile.value)
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

const isCreatingInDir = (dirRelativePath: string) => {
  const edit = inlineEdit.value
  return Boolean(edit && (edit.mode === 'create-file' || edit.mode === 'create-folder') && edit.parentDir === dirRelativePath)
}

const isRenaming = (relativePath: string) => {
  const edit = inlineEdit.value
  return Boolean(edit && edit.mode === 'rename' && edit.targetPath === relativePath)
}

const isRowDraggable = (row: FlatRow): row is FlatEntryRow =>
  row.kind === 'entry' && !isRenaming(row.entry.relativePath)

const handleRowDragStart = (event: DragEvent, row: FlatRow) => {
  if (!isRowDraggable(row)) {
    event.preventDefault()
    return
  }

  onDragStart(event, row.entry)
}

const getRowClass = (row: FlatRow) => {
  if (row.kind === 'inline-create') return 'border-accent bg-accent-soft text-text-main'

  return [
    workspaceStore.selectedPaths.includes(row.entry.relativePath) ? 'border-accent bg-accent-soft text-text-main' : '',
    (!workspaceStore.selectedPaths.includes(row.entry.relativePath) && !row.entry.isDirectory && activeFileRel.value === row.entry.relativePath) ? 'border-accent bg-accent-soft text-text-main' : '',
  ]
}

const flattened = computed((): FlatRow[] => {
  const result: FlatRow[] = []

  const insertCreateRow = (dirRelativePath: string, depth: number) => {
    if (!isCreatingInDir(dirRelativePath)) return
    result.push({ kind: 'inline-create', key: `inline-create:${dirRelativePath}`, depth, parentDir: dirRelativePath })
  }

  const walk = (dirRelativePath: string, entries: FsEntry[], depth: number) => {
    insertCreateRow(dirRelativePath, depth)
    for (const entry of entries.filter(shouldShowEntry)) {
      result.push({ kind: 'entry', key: entry.relativePath, entry, depth })
      if (entry.isDirectory && isExpanded(entry.relativePath)) {
        walk(entry.relativePath, getChildren(entry.relativePath), depth + 1)
      }
    }
  }

  walk('', getChildren(''), 0)
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
  handleFileTreeGlobalKeyDown({
    event: e,
    selectedPaths: workspaceStore.selectedPaths,
    hasInlineEdit: Boolean(inlineEdit.value),
    activeElement: document.activeElement,
    closeMenu,
    startRename,
    deleteEntries: (paths) => workspaceStore.deleteEntries(paths),
  })
}

const onCreateFileRequest = () => {
  startCreateFileFromCurrentDir().catch(console.error)
}

onMounted(() => {
  window.addEventListener('pointerdown', onGlobalPointerDown)
  window.addEventListener('keydown', onGlobalKeyDown)
  window.addEventListener(FILE_TREE_CREATE_FILE_EVENT, onCreateFileRequest)
})

onUnmounted(() => {
  window.removeEventListener('pointerdown', onGlobalPointerDown)
  window.removeEventListener('keydown', onGlobalKeyDown)
  window.removeEventListener(FILE_TREE_CREATE_FILE_EVENT, onCreateFileRequest)
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
        :key="row.key"
        class="group flex items-center gap-2 py-1.5 px-2 rounded-md border-l-2 border-transparent text-text-muted hover:bg-accent-soft hover:text-text-main"
        :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
        :class="getRowClass(row)"
        :draggable="isRowDraggable(row)"
        @dragstart="(e) => handleRowDragStart(e, row)"
        @click.exact="row.kind === 'entry' && handleRowClick($event, row.entry, false)"
        @click.ctrl.exact="row.kind === 'entry' && handleRowClick($event, row.entry, true)"
        @click.meta.exact="row.kind === 'entry' && handleRowClick($event, row.entry, true)"
        @contextmenu="(e) => row.kind === 'entry' && handleRightClick(e, row.entry)"
        @dragover.capture="(e) => row.kind === 'entry' && allowDrop(e)"
        @drop.capture.stop="(e) => row.kind === 'entry' && onDropToDir(e, row.entry.relativePath)"
      >
        <template v-if="row.kind === 'inline-create'">
          <div class="w-6 h-6"></div>
          <input
            :ref="setInlineInput"
            v-model="inlineEditValue"
            class="flex-1 min-w-0 rounded border border-accent bg-panel px-1.5 py-0.5 text-sm text-text-main outline-none"
            @click.stop
            @pointerdown.stop
            @keydown.enter.prevent.stop="submitInlineEdit"
            @keydown.esc.prevent.stop="cancelInlineEdit"
            @blur="submitInlineEdit"
          />
        </template>
        <template v-else>
          <button
            v-if="row.entry.isDirectory"
            class="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-accent-soft text-text-muted"
            @click.stop="toggle(row.entry.relativePath)"
          >
            <ChevronRight
              :size="14"
              :class="['transition-transform', isExpanded(row.entry.relativePath) ? 'rotate-90' : 'rotate-0']"
            />
          </button>
          <div v-else class="w-6 h-6"></div>

          <input
            v-if="isRenaming(row.entry.relativePath)"
            :ref="setInlineInput"
            v-model="inlineEditValue"
            class="flex-1 min-w-0 rounded border border-accent bg-panel px-1.5 py-0.5 text-sm text-text-main outline-none"
            @click.stop
            @pointerdown.stop
            @keydown.enter.prevent.stop="submitInlineEdit"
            @keydown.esc.prevent.stop="cancelInlineEdit"
            @blur="submitInlineEdit"
          />
          <template v-else>
            <div class="flex-1 min-w-0 text-left text-sm truncate select-none" :title="row.entry.name">
              {{ getEntryDisplayName(row.entry) }}
            </div>
            <div
              v-if="getEntryDisplayExt(row.entry) && getEntryDisplayExt(row.entry) !== '.md'"
              class="shrink-0 rounded-md bg-panel-soft px-1.5 py-0.5 text-[11px] leading-4 text-text-muted select-none"
            >
              {{ getEntryDisplayExt(row.entry) }}
            </div>
          </template>
        </template>
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
          title="新建文件"
          class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft"
          @click="addFile"
        >
          新建文件
        </button>
        <button
          title="新建文件夹"
          class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft"
          @click="addFolder"
        >
          新建文件夹
        </button>
        <button
          v-if="workspaceStore.selectedPaths.length === 1"
          class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft flex items-center justify-between gap-3"
          title="重命名"
          @click="startRename(workspaceStore.selectedPaths[0])"
        >
          <span>重命名</span>
          <span class="text-xs text-text-subtle">F2</span>
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
