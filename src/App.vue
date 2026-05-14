<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useWorkspaceStore } from './renderer/store/workspace';
import TopBar from './renderer/components/TopBar.vue';
import InputDialog from './renderer/components/InputDialog.vue';
import Sidebar from './renderer/components/Sidebar.vue';
import MainContent from './renderer/components/MainContent.vue';
import CommandPalette from './renderer/components/CommandPalette.vue';

const workspaceStore = useWorkspaceStore();

const SIDEBAR_WIDTH_KEY = 'looma.sidebarWidth'
const defaultSidebarWidth = 320
const minSidebarWidth = 56
const minMainContentWidth = 360

const readStoredSidebarWidth = () => {
  if (typeof localStorage === 'undefined') return defaultSidebarWidth
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  return Number.isFinite(stored) ? stored : defaultSidebarWidth
}

const clampSidebarWidth = (width: number) => {
  const maxWidth = typeof window === 'undefined'
    ? 720
    : Math.max(minSidebarWidth, window.innerWidth - minMainContentWidth)
  return Math.min(Math.max(width, minSidebarWidth), maxWidth)
}

const sidebarWidth = ref(clampSidebarWidth(readStoredSidebarWidth()))
let keyHandler: ((e: KeyboardEvent) => void) | null = null
let cleanupAppCommand: null | (() => void) = null
let isResizingSidebar = false
let previousBodyCursor = ''
let previousBodyUserSelect = ''

const persistSidebarWidth = () => {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(sidebarWidth.value)))
}

const stopSidebarResize = () => {
  if (!isResizingSidebar) return
  isResizingSidebar = false
  document.body.style.cursor = previousBodyCursor
  document.body.style.userSelect = previousBodyUserSelect
  window.removeEventListener('pointermove', onSidebarResizeMove)
  window.removeEventListener('pointerup', stopSidebarResize)
  window.removeEventListener('pointercancel', stopSidebarResize)
  persistSidebarWidth()
}

const onSidebarResizeMove = (e: PointerEvent) => {
  if (!isResizingSidebar) return
  sidebarWidth.value = clampSidebarWidth(e.clientX)
}

const onWindowResize = () => {
  const nextWidth = clampSidebarWidth(sidebarWidth.value)
  if (nextWidth !== sidebarWidth.value) {
    sidebarWidth.value = nextWidth
    persistSidebarWidth()
  }
}

const startSidebarResize = (e: PointerEvent) => {
  if (e.button !== 0) return
  e.preventDefault()
  isResizingSidebar = true
  previousBodyCursor = document.body.style.cursor
  previousBodyUserSelect = document.body.style.userSelect
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onSidebarResizeMove)
  window.addEventListener('pointerup', stopSidebarResize)
  window.addEventListener('pointercancel', stopSidebarResize)
}

onMounted(() => {
  workspaceStore.init();
  window.addEventListener('resize', onWindowResize)

  keyHandler = (e: KeyboardEvent) => {
    if (e.ctrlKey && !e.shiftKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault()
      workspaceStore.openWorkspaceInNewWindowFlow()
      return
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault()
      workspaceStore.newWorkspaceInNewWindowFlow()
      return
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault()
      if (workspaceStore.commandPaletteOpen) workspaceStore.closeCommandPalette()
      else workspaceStore.openCommandPalette()
      return
    }
  }

  window.addEventListener('keydown', keyHandler)

  cleanupAppCommand = (window as any).electronAPI?.app?.onCommand?.((cmd: { id: string }) => {
    if (cmd.id === 'workspace.switch') workspaceStore.openWorkspaceInNewWindowFlow()
    if (cmd.id === 'workspace.new') workspaceStore.newWorkspaceInNewWindowFlow()
  }) ?? null
});

onUnmounted(() => {
  stopSidebarResize()
  window.removeEventListener('resize', onWindowResize)
  if (keyHandler) window.removeEventListener('keydown', keyHandler)
  keyHandler = null
  cleanupAppCommand?.()
  cleanupAppCommand = null
})
</script>

<template>
  <div spellcheck="false" autocorrect="off" autocapitalize="off">
    <div class="h-screen w-screen flex flex-col overflow-hidden bg-bg text-text-main antialiased font-sans select-none">
      <TopBar />
      <div class="flex flex-1 overflow-hidden">
        <Sidebar :width="sidebarWidth" />
        <div
          class="relative z-10 h-full w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent-soft active:bg-accent"
          style="-webkit-app-region: no-drag"
          @pointerdown="startSidebarResize"
        />
        <MainContent />
      </div>
    </div>
    <InputDialog />
    <CommandPalette />
    <div v-if="workspaceStore.isBusy" class="fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-panel text-text-main text-xs shadow-lg">
      {{ workspaceStore.busyText || '处理中...' }}
    </div>
    <div v-if="workspaceStore.isWorkspaceTransitioning" class="fixed inset-0 z-40 bg-overlay flex items-center justify-center">
      <div class="w-[420px] max-w-[92vw] rounded-xl bg-panel border border-border-soft shadow-2xl p-5 text-center">
        <div class="mx-auto w-6 h-6 rounded-full border-2 border-border-soft border-t-accent animate-spin"></div>
        <div class="mt-3 text-sm font-semibold text-text-main">Loading</div>
        <div class="mt-1 text-xs text-text-muted">{{ workspaceStore.workspaceTransitionText || '处理中...' }}</div>
      </div>
    </div>
    <div
      v-if="workspaceStore.lastError"
      class="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-[520px] z-50 pointer-events-auto px-4 py-3 rounded-lg bg-danger text-white text-sm shadow-lg flex items-center justify-between gap-3"
      style="-webkit-app-region: no-drag"
    >
      <div>{{ workspaceStore.lastError }}</div>
      <button class="shrink-0 px-3 py-1 rounded bg-white/20 hover:bg-white/30" @click="workspaceStore.clearError()">关闭</button>
    </div>
  </div>
</template>
