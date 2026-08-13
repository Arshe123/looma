<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useWorkspaceStore, type SidebarPanelId } from '@/renderer/stores/workspace';
import { useSettingsStore } from '@/renderer/stores/settings';
import { useOllamaStore } from '@/renderer/stores/ollama';
import { useDownloadsStore } from '@/renderer/stores/downloads';
import TopBar from '@/renderer/components/TopBar.vue';
import InputDialog from '@/renderer/components/InputDialog.vue';
import ConfirmationDialog from '@/renderer/components/ConfirmationDialog.vue';
import Sidebar from '@/renderer/components/Sidebar.vue';
import MainContent from '@/renderer/components/MainContent.vue';
import CommandPalette from '@/renderer/components/CommandPalette.vue';
import AppMessages from '@/renderer/components/AppMessages.vue';
import {
  DEFAULT_SIDEBAR_WIDTH,
  MIN_EXPANDED_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampExpandedSidebarWidth,
  parseStoredSidebarWidth,
  shouldCloseSidebarOnResize,
  shouldOpenSidebarOnResize,
} from '@/renderer/utils/sidebar-layout';
import { matchesAppShortcut } from '@/shared/utils/app-shortcuts';

const workspaceStore = useWorkspaceStore();
const settingsStore = useSettingsStore();
const ollamaStore = useOllamaStore();
const downloadsStore = useDownloadsStore();
const platform = window.electronAPI.platform

const readStoredSidebarWidth = () => {
  if (typeof localStorage === 'undefined') return DEFAULT_SIDEBAR_WIDTH
  return parseStoredSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
}

const clampSidebarWidth = (width: number) => {
  const viewportWidth = typeof window === 'undefined'
    ? MIN_EXPANDED_SIDEBAR_WIDTH + 720
    : window.innerWidth
  return clampExpandedSidebarWidth(width, viewportWidth)
}

const sidebarWidth = ref(clampSidebarWidth(readStoredSidebarWidth()))
const lastOpenSidebarPanel = ref<SidebarPanelId>('files')
let keyHandler: ((e: KeyboardEvent) => void) | null = null
let cleanupAppCommand: null | (() => void) = null
let isResizingSidebar = false
let previousBodyCursor = ''
let previousBodyUserSelect = ''

const persistSidebarWidth = () => {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(sidebarWidth.value)))
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
  const isOpen = workspaceStore.activeSidebarPanel !== null
  if (shouldOpenSidebarOnResize(e.clientX, isOpen)) {
    sidebarWidth.value = clampSidebarWidth(e.clientX)
    workspaceStore.setActiveSidebarPanel(lastOpenSidebarPanel.value)
    return
  }
  if (shouldCloseSidebarOnResize(e.clientX, isOpen)) {
    sidebarWidth.value = MIN_EXPANDED_SIDEBAR_WIDTH
    workspaceStore.setActiveSidebarPanel(null)
    stopSidebarResize()
    return
  }
  sidebarWidth.value = clampSidebarWidth(e.clientX)
}

watch(
  () => workspaceStore.activeSidebarPanel,
  (panel) => {
    if (panel) lastOpenSidebarPanel.value = panel
  },
  { immediate: true },
)

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
  settingsStore.load();
  ollamaStore.attachDownloadProgress();
  ollamaStore.attachPullModelProgress();
  window.addEventListener('resize', onWindowResize)

  keyHandler = (e: KeyboardEvent) => {
    if (workspaceStore.inputDialogOpen || workspaceStore.confirmationDialogOpen) return
    if (matchesAppShortcut(e, settingsStore.appShortcuts.openWorkspace, platform)) {
      e.preventDefault()
      workspaceStore.openWorkspaceInNewWindowFlow()
      return
    }
    if (matchesAppShortcut(e, settingsStore.appShortcuts.newWorkspace, platform)) {
      e.preventDefault()
      workspaceStore.newWorkspaceInNewWindowFlow()
      return
    }
    if (matchesAppShortcut(e, settingsStore.appShortcuts.commandPalette, platform)) {
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
  ollamaStore.dispose()
  downloadsStore.dispose()
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
    <ConfirmationDialog />
    <CommandPalette />
    <AppMessages />
  </div>
</template>
