<script setup lang="ts">
import { defineAsyncComponent, ref, onMounted, onUnmounted, watch, computed } from 'vue';
import { useWorkspaceStore } from '../store/workspace';
import EditorTabs from './EditorTabs.vue';
import EditorLoadError from './editors/EditorLoadError.vue';
import { CheckCircle2, AlertCircle, FileText, FileQuestion } from 'lucide-vue-next';

const workspaceStore = useWorkspaceStore();
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

const saveError = computed(() => (workspaceStore.activeFileSaveError ? workspaceStore.activeFileSaveError : null));
const isSaving = computed(() => workspaceStore.activeFileIsSaving);

const saveTrigger = ref(0);
const editorReloadNonce = ref(0);

const getExt = (filePath: string) => {
  const base = (filePath || '').split(/[\\/]/).pop() || '';
  const idx = base.lastIndexOf('.');
  if (idx === -1) return '';
  return base.slice(idx).toLowerCase();
};

const createAsyncEditor = (loader: () => Promise<any>) => {
  return defineAsyncComponent({
    loader,
    errorComponent: EditorLoadError,
    delay: 0,
    timeout: 30000,
    onError: (_err, retry, fail, attempts) => {
      if (attempts <= 1) retry();
      else fail();
    },
  });
};

const editorByExt = {
  '.md': createAsyncEditor(() => import('./editors/MarkdownEditor.vue')),
  '.txt': createAsyncEditor(() => import('./editors/PlainTextEditor.vue')),
  '.png': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.jpg': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.jpeg': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.gif': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.webp': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.svg': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.mp4': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.webm': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.ogg': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
} as const;

const activeExt = computed(() => getExt(workspaceStore.activeFilePath));
const currentEditor = computed(() => (editorByExt as any)[activeExt.value] || null);
const isSupportedFile = computed(() => Boolean(currentEditor.value));
const editorKey = computed(() => `${workspaceStore.activeFilePath}:${activeExt.value}:${editorReloadNonce.value}`);

const currentEditorRef = ref<any>(null);

const handleSave = async (newContent: string) => {
  workspaceStore.setActiveFileContent(newContent);
  await workspaceStore.saveActiveFileContent(newContent);
};

const onEditorRetry = () => {
  editorReloadNonce.value += 1;
};

// Save snapshot right before active file path changes
watch(
  () => workspaceStore.activeFileRelativePath,
  (newRel, oldRel) => {
    // Only save snapshot if we are still in the same workspace as when the editor was loaded
    if (oldRel && currentEditorRef.value && typeof currentEditorRef.value.saveSnapshot === 'function' && !workspaceStore.isWorkspaceTransitioning) {
      currentEditorRef.value.saveSnapshot(true)
    }
  },
  { immediate: true }
);

const saveCurrentSnapshot = (e?: Event) => {
  if (workspaceStore.isWorkspaceTransitioning) return
  const skipSaveMeta = e?.type === 'request-save-snapshot'
  if (currentEditorRef.value && typeof currentEditorRef.value.saveSnapshot === 'function') {
    currentEditorRef.value.saveSnapshot(skipSaveMeta)
  }
}

onMounted(() => {
  window.addEventListener('beforeunload', saveCurrentSnapshot)
  window.addEventListener('request-save-snapshot', saveCurrentSnapshot)
  keyHandler = (e: KeyboardEvent) => {
    if (e.ctrlKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      saveTrigger.value += 1
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
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', saveCurrentSnapshot)
  window.removeEventListener('request-save-snapshot', saveCurrentSnapshot)
  saveCurrentSnapshot()
  if (keyHandler) window.removeEventListener('keydown', keyHandler)
  keyHandler = null
})
</script>

<template>
  <div class="h-full flex flex-col flex-1 bg-white dark:bg-zinc-900 overflow-hidden">
    <!-- Toolbar -->
    <EditorTabs v-if="workspaceStore.openedFiles.length > 0" />

    <!-- Workspace View Area -->
    <main v-if="workspaceStore.activeFilePath" class="flex-1 flex overflow-hidden">
      <div v-if="!isSupportedFile" class="flex-1 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-600 p-12 text-center bg-zinc-50 dark:bg-zinc-900/50">
        <FileQuestion :size="64" class="mb-6 opacity-30 text-zinc-500" />
        <h3 class="text-xl font-medium mb-2 text-zinc-600 dark:text-zinc-300">不支持的文件类型</h3>
        <p class="max-w-md text-sm opacity-80 mb-4">
          该文件格式暂时无法在编辑器中打开。
        </p>
      </div>
      
      <component
        v-else
        class="w-full flex-1"
        :is="currentEditor"
        :key="editorKey"
        ref="currentEditorRef"
        :filePath="workspaceStore.activeFilePath"
        :relativeFilePath="workspaceStore.activeFileRelativePath"
        :content="workspaceStore.activeFileContent"
        :saveTrigger="saveTrigger"
        @update:content="(v) => workspaceStore.setActiveFileContent(v)"
        @save="handleSave"
        @retry="onEditorRetry"
      />
    </main>
    
    <div v-else class="flex-1 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-600 p-12 text-center">
      <FileText :size="64" class="mb-6 opacity-20" />
      <h3 class="text-xl font-medium mb-2">Welcome to your Notes</h3>
      <p class="max-w-xs text-sm opacity-60">Select a note from the list or create a new one to get started.</p>
      <div class="mt-6 text-sm text-zinc-500 dark:text-zinc-400">从左侧选择文件开始编辑</div>
    </div>
  </div>
</template>
