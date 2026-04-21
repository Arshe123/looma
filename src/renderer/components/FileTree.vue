<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ChevronRight, Folder, FileText, Trash2, Edit3 } from 'lucide-vue-next'
import { useWorkspaceStore, type FsEntry } from '../store/workspace'

const props = defineProps<{
  workspaceId: string
  rootLabel: string
}>()

const workspaceStore = useWorkspaceStore()

const expanded = computed(() => workspaceStore.activeExpandedSet)
const selectedDir = computed(() => (workspaceStore.selectedDir || '').split('\\').join('/').replace(/^\/+/, '').replace(/\/+$/, ''))
const activeFileRel = computed(() => workspaceStore.activeFileRelativePath)

const getChildren = (dirRelativePath: string) => {
  const key = workspaceStore.keyOfDir(props.workspaceId, dirRelativePath)
  return workspaceStore.dirEntries[key] || []
}

const isExpanded = (dirRelativePath: string) => expanded.value.has(dirRelativePath)

const toggle = async (dirRelativePath: string) => {
  await workspaceStore.toggleDirExpanded(dirRelativePath)
}

const selectDir = async (dirRelativePath: string) => {
  await workspaceStore.selectDir(dirRelativePath)
}

const openFile = (relativePath: string) => {
  workspaceStore.setActiveFileRelative(relativePath)
}

const removeEntry = async (relativePath: string) => {
  await workspaceStore.deleteEntry(relativePath)
}

const renameEntry = async (relativePath: string) => {
  await workspaceStore.renameEntry(relativePath)
}

const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuDir = ref('')

const closeMenu = () => {
  menuOpen.value = false
}

const openMenu = (event: MouseEvent, targetDir: string) => {
  event.preventDefault()
  menuDir.value = targetDir
  const pad = 8
  const width = 180
  const height = 96
  const x = Math.min(event.clientX, window.innerWidth - width - pad)
  const y = Math.min(event.clientY, window.innerHeight - height - pad)
  menuX.value = Math.max(pad, x)
  menuY.value = Math.max(pad, y)
  menuOpen.value = true
}

const addFile = async () => {
  closeMenu()
  await workspaceStore.createMarkdown(undefined, menuDir.value)
}

const addFolder = async () => {
  closeMenu()
  await workspaceStore.createFolder(undefined, menuDir.value)
}

const parentDirOf = (p: string) => {
  const x = (p || '').split('\\').join('/')
  const idx = x.lastIndexOf('/')
  if (idx === -1) return ''
  return x.slice(0, idx)
}

const onDragStart = (event: DragEvent, entry: FsEntry) => {
  event.dataTransfer?.setData('text/plain', entry.relativePath)
  event.dataTransfer?.setData('application/x-workspace-id', props.workspaceId)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer?.setDragImage?.(new Image(), 0, 0)
}

const onDropToDir = async (event: DragEvent, dirRelativePath: string) => {
  event.preventDefault()
  const wsId = event.dataTransfer?.getData('application/x-workspace-id') || props.workspaceId
  const from = event.dataTransfer?.getData('text/plain')
  if (!wsId || wsId !== props.workspaceId) return
  if (!from || from === dirRelativePath) return
  const name = from.split('/').pop() || from
  const to = (dirRelativePath ? `${dirRelativePath}/${name}` : name).replace(/\/{2,}/g, '/')
  if (to === from) return
  await workspaceStore.moveEntry(from, to)
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
    <div class="px-3 py-2 flex items-center gap-2 text-xs font-semibold text-zinc-600 dark:text-zinc-400">
      <Folder :size="14" class="text-blue-500" />
      <span class="truncate">{{ props.rootLabel }}</span>
    </div>

    <div
      class="flex-1 overflow-y-auto px-2 pb-2"
      @contextmenu="(e) => openMenu(e, selectedDir)"
      @dragover="allowDrop"
      @drop="(e) => onDropToDir(e, '')"
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
          row.isDirectory && selectedDir === row.relativePath ? 'bg-zinc-100 dark:bg-zinc-800' : '',
          !row.isDirectory && activeFileRel === row.relativePath ? 'bg-zinc-100 dark:bg-zinc-800' : '',
        ]"
        draggable="true"
        @dragstart="(e) => onDragStart(e, row)"
        @contextmenu="(e) => openMenu(e, row.isDirectory ? row.relativePath : parentDirOf(row.relativePath))"
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

        <Folder v-if="row.isDirectory" :size="16" class="text-blue-500" />
        <FileText v-else :size="16" class="text-zinc-400" />

        <button
          class="flex-1 min-w-0 text-left text-sm truncate"
          @click="row.isDirectory ? selectDir(row.relativePath) : openFile(row.relativePath)"
          :title="row.name"
        >
          {{ row.name }}
        </button>

        <button
          class="opacity-0 group-hover:opacity-100 transition-opacity w-7 h-7 inline-flex items-center justify-center rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          @click.stop="renameEntry(row.relativePath)"
          title="重命名"
        >
          <Edit3 :size="16" />
        </button>

        <button
          class="opacity-0 group-hover:opacity-100 transition-opacity w-7 h-7 inline-flex items-center justify-center rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500 hover:text-red-600"
          @click.stop="removeEntry(row.relativePath)"
          title="删除"
        >
          <Trash2 :size="16" />
        </button>
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
          class="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          @click="addFile"
        >
          新建文件
        </button>
        <button
          class="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          @click="addFolder"
        >
          新建文件夹
        </button>
      </div>
    </div>
  </div>
</template>
