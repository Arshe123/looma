<script setup lang="ts">
import { computed } from 'vue'
import { Minus, Square, X, Plus } from 'lucide-vue-next'
import { useWorkspaceStore } from '../store/workspace'

const workspaceStore = useWorkspaceStore()

const activeId = computed(() => workspaceStore.activeWorkspaceId)
const tabIds = computed(() => workspaceStore.workspaces.map((w) => w.id))

const onTabClick = async (id: string) => {
  await workspaceStore.switchWorkspace(id)
}

const onTabRename = async (id: string) => {
  await workspaceStore.renameWorkspace(id)
}

const onTabRemove = async (id: string) => {
  await workspaceStore.removeWorkspace(id)
}

const onTabDragStart = (event: DragEvent, id: string) => {
  event.dataTransfer?.setData('application/x-workspace-id', id)
  event.dataTransfer?.setData('text/plain', id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

const onTabDragOver = (event: DragEvent) => {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

const onTabDrop = async (event: DragEvent, overId: string) => {
  event.preventDefault()
  const fromId = event.dataTransfer?.getData('application/x-workspace-id') || event.dataTransfer?.getData('text/plain')
  if (!fromId || fromId === overId) return
  const order = tabIds.value.slice()
  const fromIndex = order.indexOf(fromId)
  const toIndex = order.indexOf(overId)
  if (fromIndex === -1 || toIndex === -1) return
  order.splice(fromIndex, 1)
  order.splice(toIndex, 0, fromId)
  await workspaceStore.reorderWorkspaces(order)
}

const onTabDragEnd = async (event: DragEvent, id: string) => {
  if (event.dataTransfer?.dropEffect === 'none') {
    await (window as any).electronAPI?.window?.openWorkspace?.(id)
  }
}

const minimizeWindow = () => {
  ;(window as any).electronAPI?.window?.minimize?.()
}

const toggleMaximizeWindow = () => {
  ;(window as any).electronAPI?.window?.toggleMaximize?.()
}

const closeWindow = () => {
  ;(window as any).electronAPI?.window?.close?.()
}
</script>

<template>
  <header class="h-12 w-full border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900" style="-webkit-app-region: drag">
    <div class="h-full flex items-center justify-between gap-3 px-2">
      <div class="flex items-center gap-2 min-w-0" style="-webkit-app-region: no-drag">
        <div class="flex items-center gap-1 overflow-x-auto no-scrollbar min-w-0">
          <div
            v-for="ws in workspaceStore.workspaces"
            :key="ws.id"
            class="group shrink-0"
            draggable="true"
            @dragstart="(e) => onTabDragStart(e, ws.id)"
            @dragover="onTabDragOver"
            @drop="(e) => onTabDrop(e, ws.id)"
            @dragend="(e) => onTabDragEnd(e, ws.id)"
          >
            <div
              class="h-9 pl-3 pr-2 rounded-lg border flex items-center gap-2 max-w-[240px] min-w-[100px] w-full relative cursor-pointer select-none"
              :class="[
                activeId === ws.id
                  ? 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100'
                  : 'bg-zinc-100 dark:bg-zinc-800 border-transparent text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
              ]"
              @click="onTabClick(ws.id)"
              @dblclick="onTabRename(ws.id)"
              :title="ws.path"
            >
              <span class="truncate text-sm font-medium">{{ ws.name }}</span>
              <button
                class="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 inline-flex items-center justify-center rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                @click.stop="onTabRemove(ws.id)"
                title="移除"
              >
                <X :size="16" />
              </button>
            </div>
          </div>

          <button
            class="h-9 px-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700 border border-transparent"
            title="新建/打开工作空间"
            @click="workspaceStore.createWorkspaceFlow()"
          >
            <Plus :size="18" />
          </button>

          <div v-if="workspaceStore.workspaces.length === 0" class="px-2 text-xs text-zinc-500 dark:text-zinc-400">
            未打开工作空间
          </div>
        </div>
      </div>

      <div class="flex items-center gap-1" style="-webkit-app-region: no-drag">
        <button
          class="w-9 h-9 inline-flex items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
          title="最小化"
          @click="minimizeWindow"
        >
          <Minus :size="16" />
        </button>
        <button
          class="w-9 h-9 inline-flex items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
          title="最大化/还原"
          @click="toggleMaximizeWindow"
        >
          <Square :size="16" />
        </button>
        <button
          class="w-9 h-9 inline-flex items-center justify-center rounded-md text-zinc-500 hover:bg-red-500 hover:text-white"
          title="关闭"
          @click="closeWindow"
        >
          <X :size="16" />
        </button>
      </div>
    </div>
  </header>
</template>
