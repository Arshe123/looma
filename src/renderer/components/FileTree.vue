<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { ChevronRight, LoaderCircle, RefreshCw } from 'lucide-vue-next'
import { useWorkspaceStore, type FsEntry } from '../stores/workspace'
import {
  FILE_TREE_CREATE_FILE_EVENT,
  FILE_TREE_REVEAL_ACTIVE_FILE_EVENT,
  INLINE_MARKDOWN_FILENAME,
  buildCreateMarkdownName,
  buildRenameName,
  getCreateTargetDir,
  getEntryDisplayExt,
  getEntryDisplayName,
  getRenameInputName,
} from '@/shared/utils/file-tree-utils'
import { handleFileTreeGlobalKeyDown } from '@/shared/utils/file-tree-shortcuts'
import { appendTreeGuides, type TreeGuidedRow } from '@/shared/utils/tree-row-guides'
import { captureFileTreeDrop } from '@/shared/utils/external-file-drop'
import { isMacPlatform } from '../../shared/utils/window-chrome'

const isMac = isMacPlatform((window as any).electronAPI?.platform ?? '')
const platform = window.electronAPI.platform

const workspaceStore = useWorkspaceStore()
const expanded = computed(() => workspaceStore.activeExpandedSet)
const activeFileRel = computed(() => workspaceStore.activeFileRelativePath)
const rootDirKey = computed(() => workspaceStore.keyOfDir(''))
const rootLoadState = computed(() => workspaceStore.dirLoadStates[rootDirKey.value] || 'idle')
const rootLoadError = computed(() => workspaceStore.dirLoadErrors[rootDirKey.value] || '')
const hasRootSnapshot = computed(() => Object.prototype.hasOwnProperty.call(workspaceStore.dirEntries, rootDirKey.value))
const isInitialRootLoading = computed(() => !hasRootSnapshot.value && (rootLoadState.value === 'idle' || rootLoadState.value === 'loading'))

type InlineEditMode = 'create-file' | 'create-folder' | 'rename'
type InlineEditState = {
  mode: InlineEditMode
  parentDir: string
  targetPath: string
  targetName?: string
  targetIsDirectory?: boolean
  value: string
}
type FlatEntryRowBase = { kind: 'entry'; key: string; entry: FsEntry; depth: number }
type FlatInlineCreateRowBase = { kind: 'inline-create'; key: string; depth: number; parentDir: string }
type FlatRowBase = FlatEntryRowBase | FlatInlineCreateRowBase
type FlatEntryRow = TreeGuidedRow<FlatEntryRowBase>
type FlatInlineCreateRow = TreeGuidedRow<FlatInlineCreateRowBase>
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
const rowElements = new Map<string, HTMLElement>()
const externalDropRowKey = ref('')
const dropErrorMessage = ref('')
const dropTechnicalDetail = ref('')
type FileClipboardState = { mode: 'copy' | 'cut'; paths: string[] }
const fileClipboard = ref<FileClipboardState | null>(null)

const inlineEditValue = computed({
  get: () => inlineEdit.value?.value ?? '',
  set: (value: string) => {
    if (inlineEdit.value) inlineEdit.value.value = value
  },
})

const setInlineInput = (el: Element | null) => {
  inlineInput.value = el instanceof HTMLInputElement ? el : null
}

const setRowElement = (relativePath: string, el: Element | ComponentPublicInstance | null) => {
  if (el instanceof HTMLElement) {
    rowElements.set(relativePath, el)
  } else {
    rowElements.delete(relativePath)
  }
}

const revealActiveFileRow = async (relativePath: string) => {
  if (!relativePath) return
  await workspaceStore.ensureFileParentDirsExpanded(relativePath)
  await nextTick()
  rowElements.get(relativePath)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
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
  externalDropRowKey.value = ''
  const dropPayload = captureFileTreeDrop(event.dataTransfer)
  const targetDir = await getParentDirFromPath(dirRelativePath)

  if (dropPayload.kind === 'external') {
    dropErrorMessage.value = ''
    dropTechnicalDetail.value = ''
    const sourcePaths = dropPayload.sourcePaths
    if (sourcePaths.length === 0) {
      dropErrorMessage.value = '无法读取拖入文件，请从系统文件资源管理器重新拖入。'
      dropTechnicalDetail.value = 'Electron did not expose native paths for the dropped File objects.'
      return
    }
    const workspaceId = workspaceStore.activeWorkspaceId
    if (!workspaceId) return
    workspaceStore.setBusy(true, sourcePaths.length > 1 ? `正在复制 ${sourcePaths.length} 个项目...` : '正在复制文件...')
    try {
      const result = await window.electronAPI.fs.copyExternal(workspaceId, sourcePaths, targetDir)
      if (!result.success) {
        dropErrorMessage.value = '文件复制失败，请检查目标目录、重名文件或文件占用情况。'
        dropTechnicalDetail.value = result.error || 'Unknown external file copy error.'
        return
      }
      await workspaceStore.loadDir(workspaceId, targetDir)
      if (targetDir) await ensureDirExpanded(targetDir)
    } catch (error) {
      dropErrorMessage.value = '文件复制失败，请稍后重试。'
      dropTechnicalDetail.value = error instanceof Error ? error.message : String(error)
    } finally {
      workspaceStore.setBusy(false)
    }
    return
  }

  let draggedPaths: string[] = []

  try {
    const data = dropPayload.text
    if (data) {
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed)) draggedPaths = parsed
    }
  } catch {
    const raw = dropPayload.text
    if (raw) draggedPaths = [raw]
  }

  if (draggedPaths.length === 0) return
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
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes('Files') ? 'copy' : 'move'
  }
}

const handleDragOver = (event: DragEvent, rowKey: string) => {
  allowDrop(event)
  externalDropRowKey.value = event.dataTransfer?.types.includes('Files') ? rowKey : ''
}

const handleDragLeave = (event: DragEvent, rowKey: string) => {
  const currentTarget = event.currentTarget
  const relatedTarget = event.relatedTarget
  if (currentTarget instanceof Node && relatedTarget instanceof Node && currentTarget.contains(relatedTarget)) return
  if (externalDropRowKey.value === rowKey) externalDropRowKey.value = ''
}

const clearExternalDropState = () => {
  externalDropRowKey.value = ''
}

const isInsideFileTreeRow = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest('[data-file-tree-row]'))

const handleRootDragOver = (event: DragEvent) => {
  if (isInsideFileTreeRow(event.target)) return
  handleDragOver(event, '__root__')
}

const handleRootDrop = (event: DragEvent) => {
  if (isInsideFileTreeRow(event.target)) return
  void onDropToDir(event, '')
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
    externalDropRowKey.value === row.key ? 'border-accent bg-accent-soft text-text-main' : '',
  ]
}

const flattened = computed((): FlatRow[] => {
  const result: FlatRowBase[] = []

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
  return appendTreeGuides(result)
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

const clipboardPaths = () => {
  const paths = [...workspaceStore.selectedPaths]
  if (paths.length === 0 && selectedFile.value && selectedFile.value.relativePath) {
    paths.push(selectedFile.value.relativePath)
  }
  return paths
}

const handleCopyEntries = () => {
  const paths = clipboardPaths()
  if (paths.length === 0) return
  fileClipboard.value = { mode: 'copy', paths }
  closeMenu()
}

const handleCutEntries = () => {
  const paths = clipboardPaths()
  if (paths.length === 0) return
  fileClipboard.value = { mode: 'cut', paths }
  closeMenu()
}

const pasteTargetDir = async () => {
  const target = selectedFile.value
  if (!target || target.relativePath === '') return workspaceStore.getCurrentDir()
  return getParentDirFromPath(target.relativePath)
}

const keyboardPasteTargetDir = async () => {
  const selected = workspaceStore.selectedPaths
  if (selected.length === 1 && selected[0]) {
    const isFile = await workspaceStore.isFile(selected[0])
    if (!isFile) return selected[0]
  }
  return workspaceStore.getCurrentDir()
}

const handlePasteEntries = async (targetDirOverride?: string) => {
  const clip = fileClipboard.value
  const targetDir = targetDirOverride ?? (await pasteTargetDir())

  if (clip && clip.paths.length > 0) {
    if (clip.mode === 'cut') {
      await workspaceStore.moveEntries(clip.paths, targetDir)
      fileClipboard.value = null
    } else {
      await workspaceStore.copyEntries(clip.paths, targetDir)
    }
    closeMenu()
    return
  }

  const r = await window.electronAPI.fs.clipboardReadFiles()
  const workspaceId = workspaceStore.activeWorkspaceId
  if (!workspaceId) return
  if (r.success && r.data && r.data.length > 0) {
    dropErrorMessage.value = ''
    dropTechnicalDetail.value = ''
    workspaceStore.setBusy(true, r.data.length > 1 ? `正在粘贴 ${r.data.length} 个项目...` : '正在粘贴文件...')
    try {
      const result = await window.electronAPI.fs.copyExternal(workspaceId, r.data, targetDir)
      if (!result.success) {
        dropErrorMessage.value = '文件粘贴失败，请检查目标目录、重名文件或文件占用情况。'
        dropTechnicalDetail.value = result.error || 'Unknown clipboard file copy error.'
        return
      }
      await workspaceStore.loadDir(workspaceId, targetDir)
      if (targetDir) await ensureDirExpanded(targetDir)
    } catch (error) {
      dropErrorMessage.value = '文件粘贴失败，请稍后重试。'
      dropTechnicalDetail.value = error instanceof Error ? error.message : String(error)
    } finally {
      workspaceStore.setBusy(false)
    }
    closeMenu()
    return
  }

  // 剪贴板里没有文件路径时，尝试把剪贴板图片保存为文件（如 Snipaste 截图、网页复制的图片）
  dropErrorMessage.value = ''
  dropTechnicalDetail.value = ''
  workspaceStore.setBusy(true, '正在粘贴剪贴板图片...')
  try {
    const imageResult = await window.electronAPI.fs.clipboardPasteImage(workspaceId, targetDir)
    if (!imageResult.success) {
      dropErrorMessage.value = '剪贴板中没有可粘贴的文件或图片，请先在系统中复制文件、或截图后复制。'
      dropTechnicalDetail.value = [r.error, imageResult.error].filter(Boolean).join('；') || 'Clipboard contains neither file paths nor an image.'
      return
    }
    await workspaceStore.loadDir(workspaceId, targetDir)
    if (targetDir) await ensureDirExpanded(targetDir)
  } catch (error) {
    dropErrorMessage.value = '剪贴板图片粘贴失败，请稍后重试。'
    dropTechnicalDetail.value = error instanceof Error ? error.message : String(error)
  } finally {
    workspaceStore.setBusy(false)
  }
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
    platform,
    selectedPaths: workspaceStore.selectedPaths,
    hasInlineEdit: Boolean(inlineEdit.value),
    activeElement: document.activeElement,
    closeMenu,
    startRename,
    deleteEntries: (paths) => workspaceStore.deleteEntries(paths),
    copyEntries: () => handleCopyEntries(),
    cutEntries: () => handleCutEntries(),
    pasteEntries: () => keyboardPasteTargetDir().then((dir) => handlePasteEntries(dir)).catch(console.error),
  })
}

const onCreateFileRequest = () => {
  startCreateFileFromCurrentDir().catch(console.error)
}

const onRevealActiveFileRequest = () => {
  revealActiveFileRow(activeFileRel.value).catch(console.error)
}

const retryRootLoad = () => {
  const workspaceId = workspaceStore.activeWorkspaceId
  if (!workspaceId) return
  workspaceStore.loadDir(workspaceId, '').catch(console.error)
}

onMounted(() => {
  window.addEventListener('pointerdown', onGlobalPointerDown)
  window.addEventListener('keydown', onGlobalKeyDown)
  document.addEventListener('drop', clearExternalDropState, { capture: true })
  document.addEventListener('dragend', clearExternalDropState, { capture: true })
  window.addEventListener('blur', clearExternalDropState)
  window.addEventListener(FILE_TREE_CREATE_FILE_EVENT, onCreateFileRequest)
  window.addEventListener(FILE_TREE_REVEAL_ACTIVE_FILE_EVENT, onRevealActiveFileRequest)
})

watch(activeFileRel, (relativePath) => {
  revealActiveFileRow(relativePath).catch(console.error)
}, { immediate: true })

onUnmounted(() => {
  window.removeEventListener('pointerdown', onGlobalPointerDown)
  window.removeEventListener('keydown', onGlobalKeyDown)
  document.removeEventListener('drop', clearExternalDropState, { capture: true })
  document.removeEventListener('dragend', clearExternalDropState, { capture: true })
  window.removeEventListener('blur', clearExternalDropState)
  window.removeEventListener(FILE_TREE_CREATE_FILE_EVENT, onCreateFileRequest)
  window.removeEventListener(FILE_TREE_REVEAL_ACTIVE_FILE_EVENT, onRevealActiveFileRequest)
  rowElements.clear()
})
</script>

<template>
  <div class="h-full min-h-0 flex flex-col">
    <div class="shrink-0 px-4 py-3 text-sm font-semibold text-text-main">
      文件
    </div>

    <div v-if="workspaceStore.workspaces.length === 0" class="p-4">
      <div class="text-sm font-semibold text-text-main">暂未打开工作空间。请从本地文件夹开始使用</div>
      <div class="mt-2 text-xs text-text-muted">请选择或创建一个本地文件夹作为您的工作空间。</div>
      <div class="mt-4 grid grid-cols-1 gap-2">
        <button
          class="w-full px-3 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm cursor-pointer"
          @click="workspaceStore.openWorkspaceInNewWindowFlow()"
        >
          打开工作空间 ({{ isMac ? '⌘O' : 'Ctrl+O' }})
        </button>
        <button
          class="w-full px-3 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm cursor-pointer"
          @click="workspaceStore.newWorkspaceInNewWindowFlow()"
        >
          新建工作空间 ({{ isMac ? '⌘⇧N' : 'Ctrl+Shift+N' }})
        </button>
      </div>
    </div>

    <div
      v-if="workspaceStore.activeWorkspaceId"
      class="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2 focus-scrollbar"
      :class="externalDropRowKey === '__root__' ? 'border-l-2 border-accent bg-accent-soft/40' : ''"
      @click.self="workspaceStore.clearSelection()"
      @contextmenu.self="(e) => { workspaceStore.clearSelection(); openMenu(e, { name: '', relativePath: '', isDirectory: true, size: 0, mtimeMs: 0 }) }"
      @dragover="handleRootDragOver"
      @dragleave="(e) => handleDragLeave(e, '__root__')"
      @drop="handleRootDrop"
    >
      <div v-if="dropErrorMessage" class="mx-1 mb-2 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-danger">
        <div>{{ dropErrorMessage }}</div>
        <details v-if="dropTechnicalDetail" class="mt-1 text-text-muted">
          <summary class="cursor-pointer">技术详情</summary>
          <div class="mt-1 break-all font-mono text-[11px]">{{ dropTechnicalDetail }}</div>
        </details>
      </div>
      <div v-if="isInitialRootLoading" class="flex items-center gap-2 px-2 py-3 text-sm text-text-muted" role="status">
        <LoaderCircle :size="16" class="shrink-0 animate-spin text-accent" />
        <span>正在加载文件…</span>
      </div>

      <div v-else-if="rootLoadState === 'error'" class="mx-1 rounded-lg border border-danger/25 bg-danger/5 px-3 py-3">
        <div class="text-sm font-medium text-text-main">文件加载失败</div>
        <div class="mt-1 text-xs text-text-muted">请检查工作空间是否仍可访问，然后重试。</div>
        <button
          class="mt-3 inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs text-white hover:bg-accent-hover"
          @click="retryRootLoad"
        >
          <RefreshCw :size="13" />
          重新加载
        </button>
        <details v-if="rootLoadError" class="mt-2 text-xs text-text-subtle">
          <summary class="cursor-pointer">技术详情</summary>
          <div class="mt-1 break-all">{{ rootLoadError }}</div>
        </details>
      </div>

      <div v-else-if="rootLoadState === 'loaded' && flattened.length === 0" class="px-2 py-2 rounded-md text-sm text-text-subtle">
        空文件夹
      </div>

      <div
        v-for="row in flattened"
        :key="row.key"
        data-file-tree-row
        :ref="(el) => row.kind === 'entry' && setRowElement(row.entry.relativePath, el)"
        class="group relative flex items-center gap-2 py-1.5 px-2 rounded-md border-l-2 border-transparent text-text-muted hover:bg-accent-soft hover:text-text-main"
        :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
        :class="getRowClass(row)"
        :draggable="isRowDraggable(row)"
        @dragstart="(e) => handleRowDragStart(e, row)"
        @click.exact="row.kind === 'entry' && handleRowClick($event, row.entry, false)"
        @click.ctrl.exact="row.kind === 'entry' && handleRowClick($event, row.entry, true)"
        @click.meta.exact="row.kind === 'entry' && handleRowClick($event, row.entry, true)"
        @contextmenu="(e) => row.kind === 'entry' && handleRightClick(e, row.entry)"
        @dragover.capture="(e) => row.kind === 'entry' && handleDragOver(e, row.key)"
        @dragleave.capture="(e) => row.kind === 'entry' && handleDragLeave(e, row.key)"
        @drop.capture.stop="(e) => row.kind === 'entry' && onDropToDir(e, row.entry.relativePath)"
      >
        <span
          v-for="(guide, guideIndex) in row.guides"
          :key="guideIndex"
          class="pointer-events-none absolute top-0 border-l border-border-soft"
          :class="guide === 'none' ? 'hidden' : guide === 'continue' ? 'h-full' : 'h-1/2'"
          :style="{ left: `${8 + guideIndex * 14 + 7}px` }"
        ></span>
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
        <button
          v-if="workspaceStore.selectedPaths.length > 0"
          class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft flex items-center justify-between gap-3"
          title="复制"
          @click="handleCopyEntries"
        >
          <span>复制</span>
          <span class="text-xs text-text-subtle">{{ isMac ? '⌘C' : 'Ctrl+C' }}</span>
        </button>
        <button
          v-if="workspaceStore.selectedPaths.length > 0"
          class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft flex items-center justify-between gap-3"
          title="剪切"
          @click="handleCutEntries"
        >
          <span>剪切</span>
          <span class="text-xs text-text-subtle">{{ isMac ? '⌘X' : 'Ctrl+X' }}</span>
        </button>
        <button
          class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft flex items-center justify-between gap-3"
          title="粘贴"
          @click="handlePasteEntries().catch(console.error)"
        >
          <span>粘贴</span>
          <span class="text-xs text-text-subtle">{{ isMac ? '⌘V' : 'Ctrl+V' }}</span>
        </button>
        <div v-if="selectedFile.relativePath !== ''" class="h-px bg-accent-soft my-1"></div>
        <button v-if="selectedFile.relativePath !== ''" class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft" @click="handleCopyPath">
          复制绝对路径
        </button>
        <button v-if="selectedFile.relativePath !== ''" class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft" @click="handleCopyRelativePath">
          复制相对路径
        </button>
        <div v-if="selectedFile.relativePath !== ''" class="h-px bg-accent-soft my-1"></div>
        <button class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft" @click="handleRevealInExplorer">
          在文件资源管理器中显示
        </button>
      </div>
    </div>
  </div>
</template>
