<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { AUXILIARY_WIDTH_STORAGE_KEY, clampAuxiliaryWidth, parseAuxiliaryWidth } from '@/renderer/utils/auxiliary-layout';
import { useExternalDocumentsStore } from '@/renderer/stores/externalDocuments';
import { useWorkspaceStore } from '@/renderer/stores/workspace';
import AiAssistant from '@/renderer/components/ai/AiAssistant.vue';
import OutlinePanel from '@/renderer/components/OutlinePanel.vue';
import ThemeSwitcher from '@/renderer/components/ThemeSwitcher.vue';
import BreadcrumbNavigation from '@/renderer/components/BreadcrumbNavigation.vue';
import { useSettingsStore } from '@/renderer/stores/settings';
import { watchFontPreset } from '@/renderer/utils/font-preset';
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
const externalDocuments = useExternalDocumentsStore();
const editorOnly = new URLSearchParams(window.location.search).get('editorOnly') === '1';
let initialized = false;
let cleanupExternalOpen: (() => void) | undefined;
let cleanupHandoff: (() => void) | undefined;
const reportOpenDocuments = () => {
  if (!initialized || workspaceStore.isWorkspaceTransitioning) return;
  void window.electronAPI.externalDocuments.ready(workspaceStore.activeWorkspaceId, workspaceStore.tabs.flatMap(tab => tab.kind === 'file' ? [tab.relativePath] : [])).catch(console.error);
};
const cleanupWorkspaceActions = workspaceStore.$onAction(({ name }) => {
  if (['activateTab', 'openFileTab', 'openPreviewFileTab', 'openSystemTab'].includes(name)) externalDocuments.activeId = null;
});
watch(() => [workspaceStore.activeWorkspaceId, workspaceStore.tabs, workspaceStore.isWorkspaceTransitioning], reportOpenDocuments, { deep: true });
const settingsStore = useSettingsStore();
watchFontPreset(() => settingsStore.fontPreset)
const ollamaStore = useOllamaStore();
const downloadsStore = useDownloadsStore();
const platform = window.electronAPI.platform

const readStoredSidebarWidth = () => {
  if (typeof localStorage === 'undefined') return DEFAULT_SIDEBAR_WIDTH
  return parseStoredSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
}

const viewportWidth = ref(window.innerWidth)
const preferredAuxiliaryWidth = ref(parseAuxiliaryWidth(localStorage.getItem(AUXILIARY_WIDTH_STORAGE_KEY)))
const sidebarWidth = ref(readStoredSidebarWidth())
const auxiliaryWidth = computed(() => clampAuxiliaryWidth(
  preferredAuxiliaryWidth.value, viewportWidth.value,
  workspaceStore.fileSidebarOpen ? sidebarWidth.value : 56,
))

const clampSidebarWidth = (width: number) => {
  const viewportWidth = typeof window === 'undefined'
    ? MIN_EXPANDED_SIDEBAR_WIDTH + 720
    : window.innerWidth
  const reservedWidth = viewportWidth > 1100 && workspaceStore.activeAuxiliaryPanel
    ? clampAuxiliaryWidth(preferredAuxiliaryWidth.value, viewportWidth, MIN_EXPANDED_SIDEBAR_WIDTH) + 8 : 0
  return clampExpandedSidebarWidth(width, viewportWidth - reservedWidth - 20)
}

sidebarWidth.value = clampSidebarWidth(sidebarWidth.value)

const auxiliaryPanelRef = ref<HTMLElement | null>(null)
let auxiliaryDrag: { x: number; width: number; cursor: string; userSelect: string } | null = null
const stopAuxiliaryResize = () => {
  if (!auxiliaryDrag) return
  document.body.style.cursor = auxiliaryDrag.cursor
  document.body.style.userSelect = auxiliaryDrag.userSelect
  auxiliaryDrag = null
  window.removeEventListener('pointermove', moveAuxiliaryResize)
  window.removeEventListener('pointerup', stopAuxiliaryResize)
  window.removeEventListener('pointercancel', stopAuxiliaryResize)
  window.removeEventListener('blur', stopAuxiliaryResize)
  localStorage.setItem(AUXILIARY_WIDTH_STORAGE_KEY, String(Math.round(preferredAuxiliaryWidth.value)))
}
const moveAuxiliaryResize = (event: PointerEvent) => {
  if (!auxiliaryDrag) return
  preferredAuxiliaryWidth.value = clampAuxiliaryWidth(
    auxiliaryDrag.width + auxiliaryDrag.x - event.clientX, viewportWidth.value,
    workspaceStore.fileSidebarOpen ? sidebarWidth.value : 56,
  )
}
const startAuxiliaryResize = (event: PointerEvent) => {
  if (event.button !== 0 || !auxiliaryPanelRef.value) return
  event.preventDefault()
  stopSidebarResize()
  auxiliaryDrag = { x: event.clientX, width: auxiliaryPanelRef.value.getBoundingClientRect().width,
    cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', moveAuxiliaryResize)
  window.addEventListener('pointerup', stopAuxiliaryResize)
  window.addEventListener('pointercancel', stopAuxiliaryResize)
  window.addEventListener('blur', stopAuxiliaryResize)
}

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
  const isOpen = workspaceStore.fileSidebarOpen
  if (shouldOpenSidebarOnResize(e.clientX, isOpen)) {
    sidebarWidth.value = clampSidebarWidth(e.clientX)
    workspaceStore.setFileSidebarOpen(true)
    return
  }
  if (shouldCloseSidebarOnResize(e.clientX, isOpen)) {
    sidebarWidth.value = MIN_EXPANDED_SIDEBAR_WIDTH
    workspaceStore.setFileSidebarOpen(false)
    stopSidebarResize()
    return
  }
  sidebarWidth.value = clampSidebarWidth(e.clientX)
}



const onWindowResize = () => {
  viewportWidth.value = window.innerWidth
  const nextWidth = clampSidebarWidth(sidebarWidth.value)
  if (nextWidth !== sidebarWidth.value) {
    sidebarWidth.value = nextWidth
    persistSidebarWidth()
  }
}

watch(() => workspaceStore.activeAuxiliaryPanel, () => {
  stopAuxiliaryResize()
  onWindowResize()
})

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

onMounted(async () => {
  cleanupHandoff = window.electronAPI.externalDocuments.onHandoff(async request => {
    const api = window.electronAPI.externalDocuments;
    if (externalDocuments.transferring || workspaceStore.isWorkspaceTransitioning || workspaceStore.activeWorkspaceId !== request.workspaceId) {
      await api.claim(request.token, '目标工作空间正在切换，请重试');
      return;
    }
    externalDocuments.transferring = true;
    try {
      if (request.relativePath) {
        const rel = request.relativePath;
        const existing = workspaceStore.openedTextFileContents[rel];
        if (existing?.isLoading || existing?.isLoadingMore || existing?.isSaving || workspaceStore.isFileDirty(rel)) throw new Error('目标标签正在编辑或加载，请完成后重试');
        const result = await window.electronAPI.file.readMarkdown(request.document.filePath);
        if (!result.success || typeof result.data !== 'string') throw new Error(result.error || '无法读取目标文件');
        const recovery = await window.electronAPI.draftRecovery.get(request.workspaceId, rel, result.data);
        if (!recovery.success || (recovery.data && recovery.data.status !== 'none')) throw new Error('目标文件有待恢复的草稿，请先处理后重试');
        await workspaceStore.adoptExternalDocument(rel, request.document, result.data, async () => {
          if (!await api.claim(request.token)) throw new Error('文件交接已取消');
        });
      } else {
        const doc = await api.claim(request.token);
        if (doc) externalDocuments.open(doc);
      }
    } catch (error) {
      await api.claim(request.token, String(error)).catch(() => {});
      workspaceStore.setError(String(error));
    } finally { externalDocuments.transferring = false; }
  });
  cleanupExternalOpen = window.electronAPI.externalDocuments.onOpen(request => {
    if (request.kind === 'external') externalDocuments.open(request.document);
    else { externalDocuments.activeId = null; workspaceStore.openFileTab(request.relativePath); }
  });
  if (editorOnly) {
    workspaceStore.applyTheme();
    await workspaceStore.refreshWorkspaces();
  }
  else await workspaceStore.init();
  initialized = true;
  reportOpenDocuments();
  settingsStore.load();
  ollamaStore.attachDownloadProgress();
  ollamaStore.attachPullModelProgress();
  window.addEventListener('resize', onWindowResize)

  keyHandler = (e: KeyboardEvent) => {
    if (externalDocuments.transferring) return
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
  cleanupHandoff?.();
  cleanupExternalOpen?.();
  cleanupWorkspaceActions();
  stopAuxiliaryResize()
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
    <div :inert="externalDocuments.transferring || undefined" class="h-screen w-screen flex flex-col overflow-hidden bg-bg text-text-main antialiased font-sans select-none">
      <TopBar />
      <div class="workspace-layout flex flex-1 min-h-0 overflow-hidden pr-3">
        <Sidebar v-if="!editorOnly" :width="sidebarWidth" />
        <div
          class="relative z-10 h-full w-2 shrink-0 cursor-col-resize bg-transparent hover:bg-accent-soft active:bg-accent"
          style="-webkit-app-region: no-drag"
          v-if="!editorOnly"
          @pointerdown="startSidebarResize"
        />
        <MainContent />
        <aside v-if="!editorOnly && !externalDocuments.activeId && workspaceStore.activeAuxiliaryPanel" ref="auxiliaryPanelRef" :style="{ width: `${auxiliaryWidth}px` }" class="auxiliary-panel relative shrink-0 min-h-0 ml-2" aria-label="辅助面板">
          <div
            class="absolute -left-2 top-0 bottom-0 w-2 cursor-col-resize hover:bg-accent-soft active:bg-accent"
            style="-webkit-app-region: no-drag; touch-action: none"
            title="拖动调整辅助面板宽度"
            @pointerdown="startAuxiliaryResize"
          />
          <div class="h-full overflow-hidden rounded-[15px] bg-panel">
            <AiAssistant v-if="workspaceStore.activeAuxiliaryPanel === 'ai'" />
            <OutlinePanel v-else />
          </div>
        </aside>
      </div>
      <footer class="h-9 shrink-0 flex items-center gap-3 px-3">
        <template v-if="!externalDocuments.activeId && !editorOnly"><BreadcrumbNavigation /></template>
        <span v-else class="flex-1 text-xs text-text-muted truncate">{{ externalDocuments.documents.find(doc => doc.id === externalDocuments.activeId)?.filePath || '外部文件编辑器' }}</span>
        <div class="shrink-0"><ThemeSwitcher /></div>
      </footer>
    </div>
    <InputDialog />
    <ConfirmationDialog />
    <CommandPalette />
    <AppMessages />
    <div v-if="externalDocuments.transferring" role="status" class="fixed inset-0 z-[100] flex items-center justify-center bg-panel/70 text-text-main">正在交接当前文件…</div>
  </div>
</template>
