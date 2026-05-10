<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'
import { FileQuestion, FileText } from 'lucide-vue-next'
import { useWorkspaceStore } from '../store/workspace'
import EditorLoadError from './editor/EditorLoadError.vue'
import EditorTabs from './EditorTabs.vue'

const workspaceStore = useWorkspaceStore()
let keyHandler: ((e: KeyboardEvent) => void) | null = null

const saveTrigger = ref(0)
const editorReloadNonce = ref(0)

const getExt = (filePath: string) => {
  const base = (filePath || '').split(/[\\/]/).pop() || ''
  const idx = base.lastIndexOf('.')
  if (idx === -1) return ''
  return base.slice(idx).toLowerCase()
}

const createAsyncEditor = (loader: () => Promise<any>) => {
  return defineAsyncComponent({
    loader,
    errorComponent: EditorLoadError,
    delay: 0,
    timeout: 30000,
    onError: (_err, retry, fail, attempts) => {
      if (attempts <= 1) retry()
      else fail()
    },
  })
}

const editorByExt = {
  '.md': createAsyncEditor(() => import('./editor/MarkdownEditor.vue')),
  '.txt': createAsyncEditor(() => import('./editor/PlainTextEditor.vue')),
  '.png': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.jpg': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.jpeg': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.gif': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.webp': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.svg': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.mp4': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.webm': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
  '.ogg': createAsyncEditor(() => import('./preview/MediaPreview.vue')),
} as const

const activeExt = computed(() => getExt(workspaceStore.activeFilePath))
const currentEditor = computed(() => (editorByExt as any)[activeExt.value] || null)
const isSupportedFile = computed(() => Boolean(currentEditor.value))
const editorKey = computed(() => `${workspaceStore.activeFilePath}:${activeExt.value}:${editorReloadNonce.value}`)

const currentEditorRef = ref<any>(null)

const handleSave = async (newContent: string) => {
  workspaceStore.setActiveFileContent(newContent)
  await workspaceStore.saveActiveFileContent(newContent)
}

const onEditorRetry = () => {
  editorReloadNonce.value += 1
}

watch(
  () => workspaceStore.activeFileRelativePath,
  (_newRel, oldRel) => {
    if (oldRel && currentEditorRef.value && typeof currentEditorRef.value.saveSnapshot === 'function' && !workspaceStore.isWorkspaceTransitioning) {
      currentEditorRef.value.saveSnapshot(true)
    }
  },
  { immediate: true },
)

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
      if (document.activeElement?.closest('.cm-editor') || document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      e.preventDefault()
      workspaceStore.undo()
      return
    }
    if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
      if (document.activeElement?.closest('.cm-editor') || document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      e.preventDefault()
      workspaceStore.redo()
    }
  }

  window.addEventListener('keydown', keyHandler)
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', saveCurrentSnapshot)
  window.removeEventListener('request-save-snapshot', saveCurrentSnapshot)
  saveCurrentSnapshot()
  if (keyHandler) window.removeEventListener('keydown', keyHandler)
  keyHandler = null
})
</script>

<template>
  <div class="h-full flex flex-col flex-1 overflow-hidden rounded-lg bg-panel">
    <EditorTabs v-if="workspaceStore.openedFiles.length > 0" />

    <main v-if="workspaceStore.activeFilePath" class="flex-1 flex overflow-hidden">
      <div v-if="!isSupportedFile" class="flex-1 flex flex-col items-center justify-center text-text-subtle p-12 text-center bg-panel/50">
        <FileQuestion :size="64" class="mb-6 opacity-30 text-text-muted" />
        <h3 class="text-xl font-medium mb-2 text-text-main">不支持的文件类型</h3>
        <p class="max-w-md text-sm opacity-80 mb-4">该文件格式暂时无法在编辑器中打开。</p>
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

    <div v-else class="flex-1 flex flex-col items-center justify-center text-text-subtle p-12 text-center">
      <FileText :size="64" class="mb-6 opacity-20" />
      <h3 class="text-xl font-medium mb-2">欢迎来到您的笔记中</h3>
      <p class="max-w-xs text-sm opacity-60">从列表中选择一个笔记或创建一个新的笔记以开始。</p>
      <div class="mt-6 text-sm text-text-muted">从侧边栏中选择一个文件。</div>
    </div>
  </div>
</template>
