<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useWorkspaceStore } from './renderer/store/workspace';
import TopBar from './renderer/components/TopBar.vue';
import InputDialog from './renderer/components/InputDialog.vue';
import Sidebar from './renderer/components/Sidebar.vue';
import MainContent from './renderer/components/MainContent.vue';
import CommandPalette from './renderer/components/CommandPalette.vue';

const workspaceStore = useWorkspaceStore();

let keyHandler: ((e: KeyboardEvent) => void) | null = null
let cleanupAppCommand: null | (() => void) = null

onMounted(() => {
  workspaceStore.init();

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
  if (keyHandler) window.removeEventListener('keydown', keyHandler)
  keyHandler = null
  cleanupAppCommand?.()
  cleanupAppCommand = null
})
</script>

<template>
  <div class="h-screen w-screen flex flex-col overflow-hidden bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 antialiased font-sans select-none">
    <TopBar />
    <div class="flex flex-1 overflow-hidden">
      <Sidebar />
      <MainContent />
    </div>
  </div>
  <InputDialog />
  <CommandPalette />
  <div v-if="workspaceStore.isBusy" class="fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-zinc-900 text-zinc-100 text-xs shadow-lg">
    {{ workspaceStore.busyText || '处理中…' }}
  </div>
  <div v-if="workspaceStore.isWorkspaceTransitioning" class="fixed inset-0 z-40 bg-black/40 flex items-center justify-center">
    <div class="w-[420px] max-w-[92vw] rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl p-5 text-center">
      <div class="mx-auto w-6 h-6 rounded-full border-2 border-zinc-300 dark:border-zinc-700 border-t-blue-600 animate-spin"></div>
      <div class="mt-3 text-sm font-semibold text-zinc-800 dark:text-zinc-100">正在加载</div>
      <div class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{{ workspaceStore.workspaceTransitionText || '处理中…' }}</div>
    </div>
  </div>
  <div
    v-if="workspaceStore.lastError"
    class="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-[520px] z-50 pointer-events-auto px-4 py-3 rounded-lg bg-red-600 text-white text-sm shadow-lg flex items-center justify-between gap-3"
    style="-webkit-app-region: no-drag"
  >
    <div>{{ workspaceStore.lastError }}</div>
    <button class="shrink-0 px-3 py-1 rounded bg-white/20 hover:bg-white/30" @click="workspaceStore.clearError()">关闭</button>
  </div>
</template>

<style>
/* Base transitions */
* {
  transition-property: background-color, border-color, box-shadow, opacity, transform;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 150ms;
}
</style>
