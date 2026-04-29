<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import { useWorkspaceStore } from '../store/workspace';
import Editor from './Editor.vue';
import Preview from './Preview.vue';
import { Columns, Eye, Edit3, CheckCircle2, AlertCircle, FileText, FileQuestion } from 'lucide-vue-next';

const workspaceStore = useWorkspaceStore();
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

const viewMode = ref<'split' | 'editor' | 'preview'>('split');
const saveError = computed(() => (workspaceStore.activeFileSaveError ? workspaceStore.activeFileSaveError : null));
const isSaving = computed(() => workspaceStore.activeFileIsSaving);

const isSupportedFile = computed(() => {
  return workspaceStore.isSupportedActiveFile;
});

const handleSave = async (newContent: string) => {
  workspaceStore.setActiveFileContent(newContent);
  await workspaceStore.saveActiveFileContent(newContent);
};

onMounted(() => {
  keyHandler = (e: KeyboardEvent) => {
    if (e.ctrlKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      handleSave(workspaceStore.activeFileContent)
      return
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault()
      workspaceStore.createMarkdown()
      return
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      // Allow editor to handle its own undo natively if focused
      if (document.activeElement?.closest('.cm-editor') || document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      e.preventDefault()
      workspaceStore.undo()
      return
    }
    if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
      // Allow editor to handle its own redo natively if focused
      if (document.activeElement?.closest('.cm-editor') || document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      e.preventDefault()
      workspaceStore.redo()
      return
    }
  };

  window.addEventListener('keydown', keyHandler)

  if (workspaceStore.activeFilePath) {
    workspaceStore.loadActiveFileContent();
  }
});

onUnmounted(() => {
  if (keyHandler) window.removeEventListener('keydown', keyHandler)
  keyHandler = null
})

watch(() => workspaceStore.activeFilePath, (newPath) => {
  if (newPath) {
    workspaceStore.loadActiveFileContent();
  }
});
</script>

<template>
  <div class="h-full flex flex-col flex-1 bg-white dark:bg-zinc-900 overflow-hidden">
    <!-- Toolbar -->
    <header class="h-14 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between px-6 bg-zinc-50 dark:bg-zinc-900 z-10">
      <div class="flex items-center gap-3 min-w-0">
        <h1 class="text-sm font-semibold text-zinc-700 dark:text-zinc-300 truncate">
          {{ workspaceStore.activeFilePath ? workspaceStore.activeFilePath.split(/[\\/]/).pop() : '选择笔记开始编辑' }}
        </h1>
        
        <!-- Save Status Indicators -->
        <div class="flex items-center gap-2">
          <div v-if="isSaving" class="flex items-center gap-1.5 px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-[10px] text-zinc-500 font-medium">
            <div class="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse"></div>
            Saving...
          </div>
          <div v-else-if="!saveError && workspaceStore.activeFilePath" class="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-emerald-500 font-medium">
            <CheckCircle2 :size="12" />
            Saved
          </div>
          <div v-else-if="saveError" class="flex items-center gap-1 px-2 py-0.5 rounded bg-red-50 dark:bg-red-900/20 text-[10px] text-red-500 font-medium group cursor-pointer" :title="saveError">
            <AlertCircle :size="12" />
            Save Failed
          </div>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <div class="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800 p-1 rounded-lg">
          <button 
            @click="viewMode = 'editor'"
            :class="[
              'p-1.5 rounded-md transition-all',
              viewMode === 'editor' ? 'bg-white dark:bg-zinc-700 text-blue-500 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            ]"
            title="仅编辑"
          >
            <Edit3 :size="16" />
          </button>
          <button 
            @click="viewMode = 'split'"
            :class="[
              'p-1.5 rounded-md transition-all',
              viewMode === 'split' ? 'bg-white dark:bg-zinc-700 text-blue-500 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            ]"
            title="分栏"
          >
            <Columns :size="16" />
          </button>
          <button 
            @click="viewMode = 'preview'"
            :class="[
              'p-1.5 rounded-md transition-all',
              viewMode === 'preview' ? 'bg-white dark:bg-zinc-700 text-blue-500 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            ]"
            title="仅预览"
          >
            <Eye :size="16" />
          </button>
        </div>
      </div>
    </header>

    <!-- Workspace View Area -->
    <main v-if="workspaceStore.activeFilePath" class="flex-1 flex overflow-hidden">
      <div v-if="!isSupportedFile" class="flex-1 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-600 p-12 text-center bg-zinc-50 dark:bg-zinc-900/50">
        <FileQuestion :size="64" class="mb-6 opacity-30 text-zinc-500" />
        <h3 class="text-xl font-medium mb-2 text-zinc-600 dark:text-zinc-300">不支持的文件类型</h3>
        <p class="max-w-md text-sm opacity-80 mb-4">
          该文件格式暂时无法在编辑器中打开。我们目前仅支持 <span class="font-mono bg-zinc-200 dark:bg-zinc-800 px-1 py-0.5 rounded">.md</span> 和 <span class="font-mono bg-zinc-200 dark:bg-zinc-800 px-1 py-0.5 rounded">.txt</span> 文件。
        </p>
      </div>
      
      <template v-else>
        <div v-if="viewMode !== 'preview'" class="flex-1 overflow-hidden">
          <Editor 
            :initialContent="workspaceStore.activeFileContent" 
            :filePath="workspaceStore.activeFilePath"
            @change="(newContent) => workspaceStore.setActiveFileContent(newContent)"
            @save="handleSave"
          />
        </div>
        
        <div v-if="viewMode !== 'editor'" class="flex-1 overflow-hidden border-l border-zinc-200 dark:border-zinc-800">
          <Preview :content="workspaceStore.activeFileContent" />
        </div>
      </template>
    </main>
    
    <div v-else class="flex-1 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-600 p-12 text-center">
      <FileText :size="64" class="mb-6 opacity-20" />
      <h3 class="text-xl font-medium mb-2">Welcome to your Notes</h3>
      <p class="max-w-xs text-sm opacity-60">Select a note from the list or create a new one to get started.</p>
      <div class="mt-6 flex items-center gap-3">
        <button class="px-4 py-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 text-sm" @click="workspaceStore.switchWorkspaceFlow()">
          切换工作空间 (Ctrl+O)
        </button>
        <button class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm" @click="workspaceStore.newWorkspaceFlow()">
          新建工作空间 (Ctrl+Shift+N)
        </button>
      </div>
    </div>
  </div>
</template>
