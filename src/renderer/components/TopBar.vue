<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { Minus, Square, X, Plus } from 'lucide-vue-next'
import { useWorkspaceStore, type Workspace } from '../store/workspace'

const workspaceStore = useWorkspaceStore()

const activeId = computed(() => workspaceStore.activeWorkspaceId)
const tabIds = computed(() => workspaceStore.workspaces.map((w) => w.id))

const draggingId = ref<string | null>(null)
const previewOrder = ref<string[] | null>(null)
let rafToken: number | null = null
let pendingOver: { overId: string; isAfter: boolean } | null = null

// 用于记录在当前窗口中被“拖走”而隐藏的工作空间 ID
const hiddenWorkspaceIds = ref<Set<string>>(new Set())

const displayedWorkspaces = computed(() => {
  const ids = previewOrder.value ?? tabIds.value
  const byId = new Map(workspaceStore.workspaces.map((w) => [w.id, w] as const))
  return ids
    .filter((id) => !hiddenWorkspaceIds.value.has(id))
    .map((id) => byId.get(id))
    .filter((w): w is Workspace => Boolean(w))
})

watch(tabIds, (ids) => {
  if (!draggingId.value) {
    previewOrder.value = null
    return
  }
  if (!previewOrder.value) return
  const nextIds = new Set(ids)
  const next: string[] = []
  for (const id of previewOrder.value) {
    if (nextIds.has(id)) next.push(id)
  }
  for (const id of ids) {
    if (!next.includes(id)) next.push(id)
  }
  previewOrder.value = next
})

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
  draggingId.value = id
  previewOrder.value = tabIds.value.slice()
  event.dataTransfer?.setData('application/x-workspace-id', id)
  event.dataTransfer?.setData('text/plain', id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  try {
    const img = new Image()
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
    event.dataTransfer?.setDragImage?.(img, 0, 0)
  } catch {}
}

const applyPendingReorder = () => {
  const over = pendingOver
  pendingOver = null
  if (!over) return
  const fromId = draggingId.value
  if (!fromId) return

  const base = previewOrder.value ?? tabIds.value
  const order = base.slice()
  const fromIndex = order.indexOf(fromId)
  const overIndex = order.indexOf(over.overId)
  if (fromIndex === -1 || overIndex === -1) return

  let insertIndex = overIndex + (over.isAfter ? 1 : 0)
  order.splice(fromIndex, 1)
  if (fromIndex < insertIndex) insertIndex -= 1
  if (insertIndex < 0) insertIndex = 0
  if (insertIndex > order.length) insertIndex = order.length
  order.splice(insertIndex, 0, fromId)

  let changed = order.length !== base.length
  if (!changed) {
    for (let i = 0; i < order.length; i += 1) {
      if (order[i] !== base[i]) {
        changed = true
        break
      }
    }
  }
  if (changed) previewOrder.value = order
}

const onTabDragOver = (event: DragEvent, overId: string) => {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const fromId = draggingId.value
  if (!fromId || fromId === overId) return

  const el = event.currentTarget as HTMLElement | null
  let isAfter = false
  if (el) {
    const rect = el.getBoundingClientRect()
    isAfter = event.clientX - rect.left > rect.width / 2
  }

  pendingOver = { overId, isAfter }
  if (rafToken !== null) return
  rafToken = requestAnimationFrame(() => {
    rafToken = null
    applyPendingReorder()
  })
}

const onTabDrop = async (event: DragEvent, overId: string) => {
  event.preventDefault()
  const fromId = event.dataTransfer?.getData('application/x-workspace-id') || event.dataTransfer?.getData('text/plain')
  if (!fromId) return
  applyPendingReorder()
  const nextOrder = previewOrder.value ?? tabIds.value
  
  // 检查是否有实质性的排序变化，避免无意义的 API 调用
  let changed = nextOrder.length !== tabIds.value.length
  if (!changed) {
    for (let i = 0; i < nextOrder.length; i++) {
      if (nextOrder[i] !== tabIds.value[i]) {
        changed = true
        break
      }
    }
  }

  draggingId.value = null
  previewOrder.value = null
  pendingOver = null
  if (rafToken !== null) {
    cancelAnimationFrame(rafToken)
    rafToken = null
  }
  
  if (changed) {
    await workspaceStore.reorderWorkspaces(nextOrder.slice())
  }
}

const onTabDragEnd = async (event: DragEvent, id: string) => {
  try {
    const isOutside =
      event.clientX < 0 ||
      event.clientY < 0 ||
      event.clientX > window.innerWidth ||
      event.clientY > window.innerHeight

    if (isOutside || event.dataTransfer?.dropEffect === 'none') {
      // 拖拽到窗口外部，打开新窗口，并告知主进程开启孤立模式（即新窗口仅显示该工作空间）
      await (window as any).electronAPI?.window?.openWorkspace?.(id, { isolate: true })
      // 在当前窗口中隐藏该工作空间
      hiddenWorkspaceIds.value.add(id)
      
      // 如果拖走的是当前激活的工作空间，尝试切换到下一个可用的
      if (activeId.value === id) {
        const remaining = displayedWorkspaces.value
        if (remaining.length > 0) {
          await workspaceStore.switchWorkspace(remaining[0].id)
        } else {
          // 如果没有剩余的工作空间，清除当前激活状态
          await workspaceStore.clearActiveWorkspace()
        }
      }
    }
  } finally {
    draggingId.value = null
    previewOrder.value = null
    pendingOver = null
    if (rafToken !== null) {
      cancelAnimationFrame(rafToken)
      rafToken = null
    }
  }
}

const minimizeWindow = () => {
  ;(window as any).electronAPI?.window?.minimize?.()
}

const toggleMaximizeWindow = () => {
  ;(window as any).electronAPI?.window?.toggleMaximize?.()
}

const closeWindow = () => {
  const ids = displayedWorkspaces.value.map(ws => ws.id)
  ;(window as any).electronAPI?.window?.close?.(ids)
}

let cleanupPrepareClose: (() => void) | null = null

onMounted(() => {
  if ((window as any).electronAPI?.window?.onPrepareClose) {
    cleanupPrepareClose = (window as any).electronAPI.window.onPrepareClose(() => {
      closeWindow()
    })
  }
})

onUnmounted(() => {
  if (cleanupPrepareClose) cleanupPrepareClose()
})
</script>

<template>
  <header class="h-12 w-full border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900" style="-webkit-app-region: drag">
    <div class="h-full flex items-center justify-between gap-3 px-2">
      <div class="flex items-center gap-2 min-w-0" style="-webkit-app-region: no-drag">
        <div class="flex items-center gap-1 overflow-x-auto no-scrollbar min-w-0">
          <TransitionGroup name="ws-tab" tag="div" class="flex items-center gap-1">
            <div
              v-for="ws in displayedWorkspaces"
              :key="ws.id"
              class="group shrink-0"
              :draggable="workspaceStore.workspaces.length > 1"
              @dragstart="(e) => onTabDragStart(e, ws.id)"
              @dragover="(e) => onTabDragOver(e, ws.id)"
              @drop="(e) => onTabDrop(e, ws.id)"
              @dragend="(e) => onTabDragEnd(e, ws.id)"
            >
              <div
                class="h-9 pl-3 pr-2 rounded-lg border flex items-center gap-2 max-w-[240px] min-w-[100px] w-full relative cursor-pointer select-none transition-[transform,opacity] duration-150 ease-out"
                :class="[
                  activeId === ws.id
                    ? 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100'
                    : 'bg-zinc-100 dark:bg-zinc-800 border-transparent text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700',
                  draggingId === ws.id ? 'opacity-40 scale-[0.98]' : ''
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
          </TransitionGroup>

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

<style scoped>
.ws-tab-move {
  transition: transform 180ms cubic-bezier(0.2, 0, 0, 1);
  will-change: transform;
}
</style>
