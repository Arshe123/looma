<script setup lang="ts">
import { onMounted } from 'vue';
import { useWorkspaceStore } from './renderer/store/workspace';
import TopBar from './renderer/components/TopBar.vue';
import InputDialog from './renderer/components/InputDialog.vue';
import Sidebar from './renderer/components/Sidebar.vue';
import MainContent from './renderer/components/MainContent.vue';

const workspaceStore = useWorkspaceStore();

onMounted(() => {
  workspaceStore.init();
});
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
  <div v-if="workspaceStore.isBusy" class="fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-zinc-900 text-zinc-100 text-xs shadow-lg">
    {{ workspaceStore.busyText || '处理中…' }}
  </div>
  <div
    v-if="workspaceStore.lastError"
    class="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-[520px] px-4 py-3 rounded-lg bg-red-600 text-white text-sm shadow-lg flex items-center justify-between gap-3"
  >
    <div class="truncate">{{ workspaceStore.lastError }}</div>
    <button class="shrink-0 px-3 py-1 rounded bg-white/20 hover:bg-white/30" @click="workspaceStore.clearError()">关闭</button>
  </div>
</template>

<style>
/* Global scrollbar styles */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: #e2e2e2;
  border-radius: 4px;
}

.dark ::-webkit-scrollbar-thumb {
  background: #3f3f46;
}

::-webkit-scrollbar-thumb:hover {
  background: #d4d4d4;
}

.dark ::-webkit-scrollbar-thumb:hover {
  background: #52525b;
}

/* Base transitions */
* {
  transition-property: background-color, border-color, color, fill, stroke;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 150ms;
}
</style>
