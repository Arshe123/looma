<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { FileQuestion, FileText } from 'lucide-vue-next'
import { useWorkspaceStore, type FileWorkspaceTab } from '../stores/workspace'
import EditorLoadError from './editor/EditorLoadError.vue'
import EditorTabs from './EditorTabs.vue'
import SettingsPage from './SettingsPage.vue'
import RagIndexPage from './rag/RagIndexPage.vue'
import AiConversationHistoryPage from './ai/AiConversationHistoryPage.vue'
import AgentDiffPage from './ai/AgentDiffPage.vue'
import HelpPage from './help/HelpPage.vue'
import { getMediaPreviewTabs, isMediaPath, resolveWorkspaceFilePath } from '@/shared/utils/main-content-routing'
import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'
import { FILE_TREE_CREATE_FILE_EVENT } from '@/shared/utils/file-tree-utils'
import { isTextEditingTarget } from '@/shared/utils/editing-target'
import { isEditableTextPath } from '@/renderer/stores/workspace-utils'
import { createKeyedTemplateRefSetters } from '@/shared/utils/component-ref-utils'
import { parseMarkdownOutline } from '@/shared/utils/markdown-outline'
import {
  OPEN_NOTE_REF_EVENT,
  isHeadingAnchorMatch,
} from '@/shared/utils/note-link-ref'
import { isPrimaryModifierPressed } from '@/shared/utils/platform-shortcuts'

const workspaceStore = useWorkspaceStore()
const platform = window.electronAPI.platform
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
const hasHelpTab = computed(() => workspaceStore.tabs.some((tab) => tab.kind === 'system' && tab.page === 'help'))
const isActiveSettingsTab = computed(() => activeTab.value?.kind === 'system' && activeTab.value.page === 'settings')
const isActiveRagIndexTab = computed(() => activeTab.value?.kind === 'system' && activeTab.value.page === 'rag-index')
const isActiveAiHistoryTab = computed(() => activeTab.value?.kind === 'system' && activeTab.value.page === 'ai-history')
const isActiveAgentDiffTab = computed(() => activeTab.value?.kind === 'system' && activeTab.value.page === 'agent-diff')
const isActiveHelpTab = computed(() => activeTab.value?.kind === 'system' && activeTab.value.page === 'help')
const isActiveFileTab = computed(() => activeTab.value?.kind === 'file')
const activeExt = computed(() => getExt(activeTab.value?.kind === 'file' ? activeTab.value.relativePath : ''))
const currentEditor = computed(() => (editorByExt as any)[activeExt.value] || null)
const isActiveMedia = computed(() => isActiveFileTab.value && isMediaPath(workspaceStore.activeFilePath))
const isSupportedFile = computed(() => isActiveMedia.value || Boolean(currentEditor.value))
const mediaPreviewTabs = computed(() => getMediaPreviewTabs(fileTabPaths.value, workspaceStore.activeWorkspace?.path || ''))
const hasOpenTabs = computed(() => workspaceStore.tabs.length > 0)
const hasFileTabs = computed(() => fileTabPaths.value.length > 0)
const activeTextEditor = computed(() => {
  if (activeTab.value?.kind !== 'file' || !isEditableTextPath(activeTab.value.relativePath)) return null
  const workspacePath = workspaceStore.activeWorkspace?.path || ''
  const relativePath = activeTab.value.relativePath
  const state = workspaceStore.openedTextFileContents[relativePath]
  const component = (editorByExt as any)[getExt(relativePath)] || null
  const filePath = resolveWorkspaceFilePath(workspacePath, relativePath)
  if (!component || !filePath) return null
  return {
    relativePath,
    filePath,
    component,
    content: state?.content || '',
    state,
  }
})

const editorRefs = ref<Record<string, any>>({})
const helpPageRef = ref<InstanceType<typeof HelpPage> | null>(null)
const currentEditorRef = computed(() => editorRefs.value[workspaceStore.activeFileRelativePath] || null)

const setEditorRef = (relativePath: string, el: any) => {
  if (el) {
    editorRefs.value[relativePath] = el
  } else {
    delete editorRefs.value[relativePath]
  }
}

const editorRefSetters = createKeyedTemplateRefSetters<any>(setEditorRef)

watch(fileTabPaths, (paths) => {
  editorRefSetters.retain(paths)
}, { immediate: true })

const handleSave = async (newContent: string, relativePath = workspaceStore.activeFileRelativePath) => {
  workspaceStore.setActiveFileContent(newContent, relativePath)
  await workspaceStore.saveActiveFileContent(newContent, relativePath)
}

const onEditorRetry = () => {
  editorReloadNonce.value += 1
}

const jumpToHeading = (event: Event) => {
  const detail = (event as CustomEvent<MarkdownOutlineItem>).detail
  if (isActiveHelpTab.value) {
    helpPageRef.value?.scrollToHeading(detail)
    return
  }
  if (!detail || !currentEditorRef.value || typeof currentEditorRef.value.scrollToHeading !== 'function') return
  currentEditorRef.value.scrollToHeading(detail)
}

const openNoteRef = async (event: Event) => {
  const detail = (event as CustomEvent<{ relativePath: string; anchor?: { kind: string; text?: string; line?: number; start?: number } }>).detail
  if (!detail?.relativePath) return
  const relativePath = detail.relativePath

  workspaceStore.openFileTab(relativePath)
  const result = await workspaceStore.ensureTextFileFullyLoaded(relativePath)
  if (!result.success) return

  // 等待编辑器组件挂载并拿到内容
  await nextTick()
  await new Promise<void>((resolve) => {
    const startedAt = Date.now()
    const waitEditor = () => {
      const editor = editorRefs.value[relativePath]
      if (editor && workspaceStore.openedTextFileContents[relativePath] && !workspaceStore.openedTextFileContents[relativePath].isPartial) {
        resolve()
        return
      }
      if (Date.now() - startedAt > 3000) {
        resolve()
        return
      }
      setTimeout(waitEditor, 30)
    }
    waitEditor()
  })

  const editor = editorRefs.value[relativePath]
  if (!editor) return
  const content = workspaceStore.openedTextFileContents[relativePath]?.content || ''

  const anchor = detail.anchor
  if (anchor?.kind === 'line' && typeof anchor.line === 'number') {
    if (typeof editor.scrollToLine === 'function') {
      editor.scrollToLine(anchor.line)
    }
    return
  }
  if (anchor?.kind === 'line-range' && typeof anchor.start === 'number') {
    if (typeof editor.scrollToLine === 'function') {
      editor.scrollToLine(anchor.start)
    }
    return
  }
  if (anchor?.kind === 'heading' && anchor.text) {
    const outline = parseMarkdownOutline(content)
    const heading = outline.find((item) => isHeadingAnchorMatch(anchor.text as string, item.text))
    if (heading && typeof editor.scrollToHeading === 'function') {
      editor.scrollToHeading(heading)
    }
    return
  }
  // 无锚点：滚动到文件顶部
  if (typeof editor.scrollToLine === 'function') {
    editor.scrollToLine(1)
  }
}

watch(
  () => workspaceStore.activeFileRelativePath,
  (_newRel, oldRel) => {
    const previousEditor = oldRel ? editorRefs.value[oldRel] : null
    if (previousEditor && typeof previousEditor.saveSnapshot === 'function' && !workspaceStore.isWorkspaceTransitioning) {
      previousEditor.saveSnapshot(true)
    }
  },
  { immediate: true, flush: 'sync' },
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
  window.addEventListener(OPEN_NOTE_REF_EVENT, openNoteRef)
  keyHandler = (e: KeyboardEvent) => {
    const commandKey = isPrimaryModifierPressed(e, platform)
    if (commandKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      saveTrigger.value += 1
      return
    }
    if (commandKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent(FILE_TREE_CREATE_FILE_EVENT))
      return
    }
    if (commandKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (isTextEditingTarget(e.target) || isTextEditingTarget(document.activeElement)) return
      e.preventDefault()
      workspaceStore.undo()
      return
    }
    if (commandKey && (e.key === 'y' || e.key === 'Y')) {
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
  window.removeEventListener(OPEN_NOTE_REF_EVENT, openNoteRef)
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

    <HelpPage
      ref="helpPageRef"
      v-if="hasHelpTab"
      v-show="isActiveHelpTab"
    />

    <main v-if="hasFileTabs" v-show="isActiveFileTab" class="flex-1 flex overflow-hidden">
      <div class="relative flex-1 overflow-hidden">
        <div v-if="!isSupportedFile" class="h-full w-full flex flex-col items-center justify-center text-text-subtle p-12 text-center bg-panel/50">
          <FileQuestion :size="64" class="mb-6 opacity-30 text-text-muted" />
          <h3 class="text-xl font-medium mb-2 text-text-main">不支持的文件类型</h3>
          <p class="max-w-md text-sm opacity-80 mb-4">该文件格式暂时无法在编辑器中打开。</p>
        </div>

        <KeepAlive :max="3">
          <component
            v-if="activeTextEditor && !isActiveMedia"
            class="absolute inset-0 h-full w-full"
            :is="activeTextEditor.component"
            :key="`${activeTextEditor.relativePath}:${editorReloadNonce}`"
            :ref="editorRefSetters.get(activeTextEditor.relativePath)"
            :filePath="activeTextEditor.filePath"
            :relativeFilePath="activeTextEditor.relativePath"
            :content="activeTextEditor.content"
            :saveTrigger="saveTrigger"
            :isPartial="activeTextEditor.state?.isPartial || false"
            :isLoading="activeTextEditor.state?.isLoading || false"
            :isLoadingMore="activeTextEditor.state?.isLoadingMore || false"
            :totalBytes="activeTextEditor.state?.totalBytes || 0"
            :useChunkedPreview="activeTextEditor.state?.useChunkedPreview || false"
            @load-more="workspaceStore.loadNextTextFileChunk(activeTextEditor!.relativePath)"
            @ensure-loaded="workspaceStore.ensureTextFileFullyLoaded(activeTextEditor!.relativePath)"
            @update:content="(v) => workspaceStore.setActiveFileContent(v, activeTextEditor!.relativePath)"
            @save="(v) => handleSave(v, activeTextEditor!.relativePath)"
            @retry="onEditorRetry"
          />
        </KeepAlive>

        <MediaPreview
          v-for="tab in mediaPreviewTabs"
          v-show="isActiveMedia && tab.relativePath === workspaceStore.activeFileRelativePath"
          :key="tab.relativePath"
          class="absolute inset-0 h-full w-full"
          :filePath="tab.filePath"
        />
      </div>
    </main>

    <div v-if="!hasOpenTabs || (!isActiveFileTab && !isActiveSettingsTab && !isActiveRagIndexTab && !isActiveAiHistoryTab && !isActiveAgentDiffTab && !isActiveHelpTab)" class="flex-1 flex flex-col items-center justify-center text-text-subtle p-12 text-center">
      <FileText :size="64" class="mb-6 opacity-20" />
      <h3 class="text-xl font-medium mb-2">欢迎来到您的笔记中</h3>
      <p class="max-w-xs text-sm opacity-60">从列表中选择一个笔记或创建一个新的笔记以开始。</p>
    </div>
  </div>
</template>
