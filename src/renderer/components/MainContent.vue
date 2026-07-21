<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'
import { FileQuestion, FileText } from 'lucide-vue-next'
import { useWorkspaceStore, type FileWorkspaceTab } from '../stores/workspace'
import EditorLoadError from './editor/EditorLoadError.vue'
import EditorTabs from './EditorTabs.vue'
import SettingsPage from './SettingsPage.vue'
import RagIndexPage from './rag/RagIndexPage.vue'
import AiConversationHistoryPage from './ai/AiConversationHistoryPage.vue'
import AgentDiffPage from './ai/AgentDiffPage.vue'
import { getMediaPreviewTabs, isMediaPath, resolveWorkspaceFilePath } from '@/shared/utils/main-content-routing'
import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'
import { FILE_TREE_CREATE_FILE_EVENT } from '@/shared/utils/file-tree-utils'
import { isTextEditingTarget } from '@/shared/utils/editing-target'
import { isEditableTextPath } from '@/renderer/stores/workspace-utils'

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

const MediaPreview = createAsyncEditor(() => import('./preview/MediaPreview.vue'))

const editorByExt = {
  '.md': createAsyncEditor(() => import('./editor/MarkdownEditor.vue')),
  '.txt': createAsyncEditor(() => import('./editor/PlainTextEditor.vue')),
} as const

const activeTab = computed(() => workspaceStore.tabs.find((tab) => tab.id === workspaceStore.activeTabId) || null)
const fileTabPaths = computed(() => workspaceStore.tabs
  .filter((tab): tab is FileWorkspaceTab => tab.kind === 'file')
  .map((tab) => tab.relativePath))
const hasSettingsTab = computed(() => workspaceStore.tabs.some((tab) => tab.kind === 'system' && tab.page === 'settings'))
const hasRagIndexTab = computed(() => workspaceStore.tabs.some((tab) => tab.kind === 'system' && tab.page === 'rag-index'))
const hasAiHistoryTab = computed(() => workspaceStore.tabs.some((tab) => tab.kind === 'system' && tab.page === 'ai-history'))
const hasAgentDiffTab = computed(() => workspaceStore.tabs.some((tab) => tab.kind === 'system' && tab.page === 'agent-diff'))
const isActiveSettingsTab = computed(() => activeTab.value?.kind === 'system' && activeTab.value.page === 'settings')
const isActiveRagIndexTab = computed(() => activeTab.value?.kind === 'system' && activeTab.value.page === 'rag-index')
const isActiveAiHistoryTab = computed(() => activeTab.value?.kind === 'system' && activeTab.value.page === 'ai-history')
const isActiveAgentDiffTab = computed(() => activeTab.value?.kind === 'system' && activeTab.value.page === 'agent-diff')
const isActiveFileTab = computed(() => activeTab.value?.kind === 'file')
const activeExt = computed(() => getExt(workspaceStore.activeFilePath))
const currentEditor = computed(() => (editorByExt as any)[activeExt.value] || null)
const isActiveMedia = computed(() => isActiveFileTab.value && isMediaPath(workspaceStore.activeFilePath))
const isSupportedFile = computed(() => isActiveMedia.value || Boolean(currentEditor.value))
const mediaPreviewTabs = computed(() => getMediaPreviewTabs(fileTabPaths.value, workspaceStore.activeWorkspace?.path || ''))
const hasOpenTabs = computed(() => workspaceStore.tabs.length > 0)
const hasFileTabs = computed(() => fileTabPaths.value.length > 0)
const textEditorTabs = computed(() => {
  const workspacePath = workspaceStore.activeWorkspace?.path || ''
  return fileTabPaths.value
    .filter(isEditableTextPath)
    .map((relativePath) => {
      const ext = getExt(relativePath)
      return {
        relativePath,
        filePath: resolveWorkspaceFilePath(workspacePath, relativePath),
        component: (editorByExt as any)[ext] || null,
        content: workspaceStore.openedTextFileContents[relativePath]?.content || '',
      }
    })
    .filter((tab) => tab.component && tab.filePath)
})

const editorRefs = ref<Record<string, any>>({})
const currentEditorRef = computed(() => editorRefs.value[workspaceStore.activeFileRelativePath] || null)

const setEditorRef = (relativePath: string, el: any) => {
  if (el) {
    editorRefs.value[relativePath] = el
  } else {
    delete editorRefs.value[relativePath]
  }
}

const handleSave = async (newContent: string, relativePath = workspaceStore.activeFileRelativePath) => {
  workspaceStore.setActiveFileContent(newContent, relativePath)
  await workspaceStore.saveActiveFileContent(newContent, relativePath)
}

const onEditorRetry = () => {
  editorReloadNonce.value += 1
}

const jumpToHeading = (event: Event) => {
  const detail = (event as CustomEvent<MarkdownOutlineItem>).detail
  if (!detail || !currentEditorRef.value || typeof currentEditorRef.value.scrollToHeading !== 'function') return
  currentEditorRef.value.scrollToHeading(detail)
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

watch(
  () => [workspaceStore.activeWorkspace?.path || '', fileTabPaths.value.join('\0')] as const,
  () => {
    for (const relPath of fileTabPaths.value) {
      if (isEditableTextPath(relPath)) {
        workspaceStore.loadTextFileContent(relPath).catch(() => {})
      }
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
  window.addEventListener('looma:jump-to-heading', jumpToHeading)
  keyHandler = (e: KeyboardEvent) => {
    if (e.ctrlKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      saveTrigger.value += 1
      return
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent(FILE_TREE_CREATE_FILE_EVENT))
      return
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (isTextEditingTarget(e.target) || isTextEditingTarget(document.activeElement)) return
      e.preventDefault()
      workspaceStore.undo()
      return
    }
    if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
      if (isTextEditingTarget(e.target) || isTextEditingTarget(document.activeElement)) return
      e.preventDefault()
      workspaceStore.redo()
    }
  }

  window.addEventListener('keydown', keyHandler)
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', saveCurrentSnapshot)
  window.removeEventListener('request-save-snapshot', saveCurrentSnapshot)
  window.removeEventListener('looma:jump-to-heading', jumpToHeading)
  saveCurrentSnapshot()
  if (keyHandler) window.removeEventListener('keydown', keyHandler)
  keyHandler = null
})
</script>

<template>
  <div class="h-full flex flex-col flex-1 overflow-hidden rounded-lg bg-panel">
    <EditorTabs v-if="hasOpenTabs" />

    <SettingsPage
      v-if="hasSettingsTab"
      v-show="isActiveSettingsTab"
    />

    <RagIndexPage
      v-if="hasRagIndexTab"
      v-show="isActiveRagIndexTab"
    />

    <AiConversationHistoryPage
      v-if="hasAiHistoryTab"
      v-show="isActiveAiHistoryTab"
    />

    <AgentDiffPage
      v-if="hasAgentDiffTab"
      v-show="isActiveAgentDiffTab"
    />

    <main v-if="hasFileTabs" v-show="isActiveFileTab" class="flex-1 flex overflow-hidden">
      <div class="relative flex-1 overflow-hidden">
        <div v-if="!isSupportedFile" class="h-full w-full flex flex-col items-center justify-center text-text-subtle p-12 text-center bg-panel/50">
          <FileQuestion :size="64" class="mb-6 opacity-30 text-text-muted" />
          <h3 class="text-xl font-medium mb-2 text-text-main">不支持的文件类型</h3>
          <p class="max-w-md text-sm opacity-80 mb-4">该文件格式暂时无法在编辑器中打开。</p>
        </div>

        <template v-if="textEditorTabs.length > 0">
          <component
            v-for="tab in textEditorTabs"
            v-show="!isActiveMedia && tab.relativePath === workspaceStore.activeFileRelativePath"
            class="absolute inset-0 h-full w-full"
            :is="tab.component"
            :key="`${tab.relativePath}:${editorReloadNonce}`"
            :ref="(el) => setEditorRef(tab.relativePath, el)"
            :filePath="tab.filePath"
            :relativeFilePath="tab.relativePath"
            :content="tab.content"
            :saveTrigger="tab.relativePath === workspaceStore.activeFileRelativePath ? saveTrigger : 0"
            @update:content="(v) => workspaceStore.setActiveFileContent(v, tab.relativePath)"
            @save="(v) => handleSave(v, tab.relativePath)"
            @retry="onEditorRetry"
          />
        </template>

        <MediaPreview
          v-for="tab in mediaPreviewTabs"
          v-show="isActiveMedia && tab.relativePath === workspaceStore.activeFileRelativePath"
          :key="tab.relativePath"
          class="absolute inset-0 h-full w-full"
          :filePath="tab.filePath"
        />
      </div>
    </main>

    <div v-if="!hasOpenTabs || (!isActiveFileTab && !isActiveSettingsTab && !isActiveRagIndexTab && !isActiveAiHistoryTab && !isActiveAgentDiffTab)" class="flex-1 flex flex-col items-center justify-center text-text-subtle p-12 text-center">
      <FileText :size="64" class="mb-6 opacity-20" />
      <h3 class="text-xl font-medium mb-2">欢迎来到您的笔记中</h3>
      <p class="max-w-xs text-sm opacity-60">从列表中选择一个笔记或创建一个新的笔记以开始。</p>
      <div class="mt-6 text-sm text-text-muted">从侧边栏中选择一个文件。</div>
    </div>
  </div>
</template>
