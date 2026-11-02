<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, provide, ref, shallowRef, watch } from 'vue'
import { externalDocumentKey, type DocumentSession } from './documentSession'
import { Columns, Edit3, Eye } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import { useSettingsStore } from '@/renderer/stores/settings'
import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'
import type TiptapPreviewComponent from '../preview/TiptapPreview.vue'
import type EditorComponent from './Editor.vue'
import type ChunkedEditorComponent from './ChunkedMarkdownEditor.vue'
import { ChunkedDocument } from '@/shared/utils/chunked-document'
import { normalizeMarkdownNoteLinks } from '@/shared/utils/markdown-note-links'
import type { ScrollSyncState } from '@/shared/types/ScrollSyncState'
import { isPrimaryModifierPressed } from '@/shared/utils/platform-shortcuts'
import { getNextRichTextZoom } from '@/shared/utils/rich-text-zoom'

const Editor = defineAsyncComponent(() => import('./Editor.vue'))
const TiptapPreview = defineAsyncComponent(() => import('../preview/TiptapPreview.vue'))
const ChunkedMarkdownEditor = defineAsyncComponent(() => import('./ChunkedMarkdownEditor.vue'))
const NoteLinkPreview = defineAsyncComponent(() => import('../preview/NoteLinkPreview.vue'))

const props = defineProps<{
  documentSession?: DocumentSession
  filePath: string
  relativeFilePath: string
  content: string
  saveTrigger: number
  isPartial: boolean
  isLoading: boolean
  isLoadingMore: boolean
  totalBytes: number
  useChunkedPreview: boolean
}>()

const emit = defineEmits<{
  (e: 'update:content', value: string, relativePath: string): void
  (e: 'save', value: string, relativePath: string): void
  (e: 'load-more'): void
  (e: 'edit-pending', relativePath: string): void
}>()

const workspaceStore = useWorkspaceStore()
provide(externalDocumentKey, Boolean(props.documentSession))
const getSession = () => props.documentSession?.getSession() ?? (props.documentSession ? undefined : workspaceStore.fileSessions[props.relativeFilePath])
const saveSession = (session: Parameters<DocumentSession['saveSession']>[0], skipSaveMeta = false) => {
  if (props.documentSession) props.documentSession.saveSession(session)
  else workspaceStore.saveFileSession(props.relativeFilePath, session, skipSaveMeta)
}
const settingsStore = useSettingsStore()
const viewMode = ref<'split' | 'editor' | 'preview'>('preview')
const splitRatio = ref(0.5)
const splitContainerRef = ref<HTMLElement | null>(null)
const editorRef = ref<InstanceType<typeof EditorComponent> | InstanceType<typeof ChunkedEditorComponent> | null>(null)
const previewRef = ref<InstanceType<typeof TiptapPreviewComponent> | null>(null)
const chunkedPreviewRef = ref<InstanceType<typeof ChunkedEditorComponent> | null>(null)
const isPreparingFullContent = ref(false)
const isBackgroundLoading = ref(false)
const fullContentError = ref('')
const useChunkedEditor = computed(() => props.useChunkedPreview)
// Both panes and all modes share one source document and undo history.
const chunkDocument = shallowRef<ChunkedDocument | null>(null)
const chunkRevision = ref(0)
let lastPublishedChunkContent: string | undefined
const getEditablePreview = () => useChunkedEditor.value ? chunkedPreviewRef.value : previewRef.value
const getSourceChunkEditor = () => useChunkedEditor.value ? editorRef.value as InstanceType<typeof ChunkedEditorComponent> | null : null
const handleChunkContent = (content: string) => {
  lastPublishedChunkContent = content
  emit('update:content', content, props.relativeFilePath)
}
const handleChunkSave = (content: string) => {
  handleChunkContent(content)
  emit('save', content, props.relativeFilePath)
}
const handleChunkChange = () => { chunkRevision.value = chunkDocument.value?.revision ?? 0 }
watch(useChunkedEditor, enabled => {
  if (enabled && !chunkDocument.value) chunkDocument.value = new ChunkedDocument(props.content)
}, { immediate: true })
watch(() => props.content, content => {
  const document = chunkDocument.value
  if (!document || content === lastPublishedChunkContent || content === document.content) return
  if (content === normalizeMarkdownNoteLinks(document.content)) document.reconcileSavedContent(content)
  else document.replaceExternal(content)
  handleChunkChange()
})
let fullContentPreparation: Promise<boolean> | null = null
let fullContentRequest = 0
let backgroundLoadFrame = 0
let editorActive = true
let activationGeneration = 0
const zoomIndicatorVisible = ref(false)
let isResizingSplit = false
let previousBodyCursor = ''
let previousBodyUserSelect = ''
let isSyncingScroll = false
let ignoreEditorScrollUntil = 0
let ignorePreviewScrollUntil = 0
let lastZoomWheelAt = 0
let zoomIndicatorTimer: number | null = null
let hasActivatedOnce = false
let restoreGeneration = 0
const SCROLL_SYNC_GUARD_MS = 180
const ZOOM_WHEEL_THROTTLE_MS = 80
const ZOOM_INDICATOR_DURATION_MS = 900

const clampSplitRatio = (ratio: number) => Math.min(Math.max(ratio, 0.2), 0.8)

const saveMarkdownSession = (skipSaveMeta = false) => {
  if (!props.documentSession && workspaceStore.isWorkspaceTransitioning) return
  const session = getSession()
  const existing = session?.markdown
  saveSession({
    markdown: {
      viewMode: viewMode.value,
      splitRatio: splitRatio.value,
      editorScroll: existing?.editorScroll,
      previewScroll: existing?.previewScroll,
    },
    ...(session?.codemirror ? { codemirror: session.codemirror } : {}),
  }, skipSaveMeta)
}

const getMarkdownSnapshot = () => {
  const existing = getSession()?.markdown
  return {
    viewMode: viewMode.value,
    splitRatio: splitRatio.value,
    editorScroll: editorRef.value?.getScrollState?.() || existing?.editorScroll,
    previewScroll: getRenderedPreviewScrollState() || existing?.previewScroll,
  }
}

const saveSnapshot = (skipSaveMeta = false) => {
  if (!props.documentSession && workspaceStore.isWorkspaceTransitioning) return
  const cmSnap = editorRef.value?.getSnapshot() || chunkedPreviewRef.value?.getSnapshot()
  saveSession({
    markdown: getMarkdownSnapshot(),
    ...(cmSnap ? { codemirror: cmSnap } : {}),
  }, skipSaveMeta)
}

const restoreSnapshot = async (focusVisibleEditor = false) => {
  const generation = ++restoreGeneration
  const session = getSession()
  if (!session) return
  const editorScroll = session.markdown?.editorScroll
  const previewScroll = session.markdown?.previewScroll

  await nextTick()
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (generation !== restoreGeneration) return
      if (viewMode.value !== 'preview') {
        if (session.codemirror) {
          editorRef.value?.applySnapshot(session.codemirror, {
            focus: focusVisibleEditor,
          })
          if (editorScroll) {
            requestAnimationFrame(() => {
              if (generation === restoreGeneration) {
                editorRef.value?.applyScrollState?.(editorScroll)
              }
            })
          }
        } else if (editorScroll) {
          editorRef.value?.applyScrollState?.(editorScroll)
        }
      }
      if (viewMode.value !== 'editor' && previewScroll) {
        applyRenderedPreviewScrollState(previewScroll)
      }
      if (viewMode.value === 'preview' && useChunkedEditor.value && session.codemirror) {
        chunkedPreviewRef.value?.applySnapshot(session.codemirror)
      }
      if (focusVisibleEditor && viewMode.value === 'preview') {
        getEditablePreview()?.focus?.()
      }
    })
  })
}

watch(chunkedPreviewRef, preview => {
  if (!preview || viewMode.value !== 'preview') return
  const session = getSession()
  const generation = restoreGeneration
  void nextTick(() => {
    if (generation !== restoreGeneration || preview !== chunkedPreviewRef.value) return
    if (session?.codemirror) preview.applySnapshot(session.codemirror)
    if (session?.markdown?.previewScroll) preview.applyScrollState(session.markdown.previewScroll)
  })
})

const stopSplitResize = () => {
  if (!isResizingSplit) return
  isResizingSplit = false
  document.body.style.cursor = previousBodyCursor
  document.body.style.userSelect = previousBodyUserSelect
  window.removeEventListener('pointermove', onSplitResizeMove)
  window.removeEventListener('pointerup', stopSplitResize)
  window.removeEventListener('pointercancel', stopSplitResize)
  saveMarkdownSession()
}

const onSplitResizeMove = (e: PointerEvent) => {
  if (!isResizingSplit || !splitContainerRef.value) return
  const rect = splitContainerRef.value.getBoundingClientRect()
  if (rect.width <= 0) return
  splitRatio.value = clampSplitRatio((e.clientX - rect.left) / rect.width)
}

const startSplitResize = (e: PointerEvent) => {
  if (e.button !== 0) return
  e.preventDefault()
  isResizingSplit = true
  previousBodyCursor = document.body.style.cursor
  previousBodyUserSelect = document.body.style.userSelect
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onSplitResizeMove)
  window.addEventListener('pointerup', stopSplitResize)
  window.addEventListener('pointercancel', stopSplitResize)
}

const withScrollSync = (fn: () => void) => {
  if (isSyncingScroll) return
  isSyncingScroll = true
  fn()
  requestAnimationFrame(() => {
    isSyncingScroll = false
  })
}

const getCurrentScrollState = () => {
  const previewState = useChunkedEditor.value
    ? chunkedPreviewRef.value?.getScrollState?.()
    : previewRef.value?.getScrollState?.()
  if (viewMode.value === 'preview') return previewState
  return editorRef.value?.getScrollState?.() || previewState
}

const syncVisibleViewsFrom = (state?: ScrollSyncState | null) => {
  if (!state) return
  withScrollSync(() => {
    if (viewMode.value !== 'preview') {
      editorRef.value?.applyScrollState?.(state)
    }
    if (viewMode.value !== 'editor') {
      if (useChunkedEditor.value) chunkedPreviewRef.value?.applyScrollState?.(state)
      else previewRef.value?.applyScrollState?.(state)
    }
  })
}

const syncSplitScrollFromEditor = (state: ScrollSyncState) => {
  if (viewMode.value !== 'split' || Date.now() < ignoreEditorScrollUntil) return
  ignorePreviewScrollUntil = Date.now() + SCROLL_SYNC_GUARD_MS
  if (useChunkedEditor.value) chunkedPreviewRef.value?.applyScrollState?.(state)
  else previewRef.value?.applyScrollState?.(state)
}

const syncSplitScrollFromPreview = (state: ScrollSyncState) => {
  if (viewMode.value !== 'split' || Date.now() < ignorePreviewScrollUntil) return
  ignoreEditorScrollUntil = Date.now() + SCROLL_SYNC_GUARD_MS
  editorRef.value?.applyScrollState?.(state)
}

const getRenderedPreviewScrollState = () => useChunkedEditor.value
  ? chunkedPreviewRef.value?.getScrollState?.()
  : previewRef.value?.getScrollState?.()

const applyRenderedPreviewScrollState = (state?: ScrollSyncState | null) => {
  if (!state) return
  if (useChunkedEditor.value) chunkedPreviewRef.value?.applyScrollState?.(state)
  else previewRef.value?.applyScrollState?.(state)
}

const showZoomIndicator = () => {
  zoomIndicatorVisible.value = true
  if (zoomIndicatorTimer !== null) window.clearTimeout(zoomIndicatorTimer)
  zoomIndicatorTimer = window.setTimeout(() => {
    zoomIndicatorVisible.value = false
    zoomIndicatorTimer = null
  }, ZOOM_INDICATOR_DURATION_MS)
}

const handleRichTextZoomWheel = (event: WheelEvent) => {
  if (!isPrimaryModifierPressed(event, window.electronAPI.platform) || event.deltaY === 0) return
  event.preventDefault()

  const now = Date.now()
  if (now - lastZoomWheelAt < ZOOM_WHEEL_THROTTLE_MS) return
  lastZoomWheelAt = now

  const nextZoom = getNextRichTextZoom(settingsStore.richTextZoom, event.deltaY)
  showZoomIndicator()
  if (nextZoom === settingsStore.richTextZoom) return
  const scrollState = getRenderedPreviewScrollState()
  void settingsStore.setRichTextZoom(nextZoom)
  nextTick(() => {
    requestAnimationFrame(() => applyRenderedPreviewScrollState(scrollState))
  })
}

const prepareFullContent = (background = false) => {
  if (fullContentPreparation) {
    if (!background) isPreparingFullContent.value = true
    return fullContentPreparation
  }
  const request = ++fullContentRequest
  const relativePath = props.relativeFilePath
  const filePath = props.filePath
  const shouldContinue = () => editorActive && request === fullContentRequest
    && props.relativeFilePath === relativePath && props.filePath === filePath
  isPreparingFullContent.value = !background
  isBackgroundLoading.value = background
  fullContentError.value = ''
  fullContentPreparation = (async () => {
    try {
      const result = await workspaceStore.ensureTextFileFullyLoaded(relativePath, { shouldContinue })
      if (!shouldContinue()) return false
      if (!result.success) fullContentError.value = result.error || '无法加载完整笔记，请重试。'
      return result.success
    } catch (error) {
      if (!shouldContinue()) return false
      fullContentError.value = `无法加载完整笔记：${error instanceof Error ? error.message : '读取失败'}。请重试。`
      return false
    } finally {
      if (request === fullContentRequest) {
        isPreparingFullContent.value = false
        isBackgroundLoading.value = false
        fullContentPreparation = null
      }
    }
  })()
  return fullContentPreparation
}

const cancelBackgroundLoad = () => {
  if (backgroundLoadFrame) cancelAnimationFrame(backgroundLoadFrame)
  backgroundLoadFrame = 0
  fullContentRequest++
  fullContentPreparation = null
  isPreparingFullContent.value = false
  isBackgroundLoading.value = false
}
const queueBackgroundLoad = () => {
  if (backgroundLoadFrame) cancelAnimationFrame(backgroundLoadFrame)
  backgroundLoadFrame = 0
  const canStart = () => editorActive && useChunkedEditor.value && props.isPartial && !props.isLoading
    && !!(chunkedPreviewRef.value || getSourceChunkEditor()) && !fullContentPreparation && !fullContentError.value
  if (!canStart()) return
  // Give the mounted first screen a paint opportunity before reading the rest.
  backgroundLoadFrame = requestAnimationFrame(() => {
    backgroundLoadFrame = requestAnimationFrame(() => {
      backgroundLoadFrame = 0
      if (canStart()) void prepareFullContent(true)
    })
  })
}
watch([useChunkedEditor, () => props.isPartial, () => props.isLoading, chunkedPreviewRef, editorRef], queueBackgroundLoad, { flush: 'post' })

const setViewMode = async (nextMode: 'split' | 'editor' | 'preview') => {
  if (viewMode.value === nextMode) return
  getEditablePreview()?.flushPendingMarkdownEmit?.()
  getSourceChunkEditor()?.flushPendingMarkdownEmit?.()
  if (nextMode !== 'preview' && (props.isPartial || props.isLoading)) {
    if (!await prepareFullContent()) return
  }
  const state = getCurrentScrollState()
  viewMode.value = nextMode
  nextTick(() => {
    requestAnimationFrame(() => syncVisibleViewsFrom(state))
  })
}

const requestChunkEdit = async (offset: number) => {
  const generation = activationGeneration
  const relativePath = props.relativeFilePath
  if ((props.isPartial || props.isLoading) && !await prepareFullContent()) return
  await nextTick()
  if (!editorActive || generation !== activationGeneration || relativePath !== props.relativeFilePath) return
  void chunkedPreviewRef.value?.startEditing(offset)
}

onMounted(async () => {
  const session = getSession()
  if (session) {
    if (session.markdown?.viewMode) viewMode.value = session.markdown.viewMode
    if (typeof session.markdown?.splitRatio === 'number') splitRatio.value = clampSplitRatio(session.markdown.splitRatio)
    if (viewMode.value !== 'preview' && (props.isPartial || props.isLoading)) {
      if (!await prepareFullContent()) viewMode.value = 'preview'
    }
  }
  void restoreSnapshot(false)
})

onActivated(() => {
  editorActive = true
  queueBackgroundLoad()
  if (!hasActivatedOnce) {
    hasActivatedOnce = true
    return
  }
  void restoreSnapshot(true)
})

onDeactivated(() => {
  editorActive = false
  activationGeneration++
  cancelBackgroundLoad()
  restoreGeneration += 1
})

onUnmounted(() => {
  editorActive = false
  activationGeneration++
  cancelBackgroundLoad()
  stopSplitResize()
  if (zoomIndicatorTimer !== null) window.clearTimeout(zoomIndicatorTimer)
})

watch(viewMode, () => {
  saveMarkdownSession()
})

watch(
  () => props.saveTrigger,
  async () => {
    if (props.isPartial || props.isLoading) {
      const result = await workspaceStore.ensureTextFileFullyLoaded(props.relativeFilePath)
      if (!result.success) return
      await nextTick()
    }
    const flushedContent = getEditablePreview()?.flushPendingMarkdownEmit?.() ?? getSourceChunkEditor()?.flushPendingMarkdownEmit?.()
    emit(
      'save',
      flushedContent ?? (props.documentSession ? props.content : workspaceStore.openedTextFileContents[props.relativeFilePath]?.content) ?? props.content,
      props.relativeFilePath,
    )
  },
)

defineExpose({
  isNavigationReady() {
    const sourceReady = viewMode.value === 'preview' || !!editorRef.value
    const previewReady = viewMode.value === 'editor' || !!(useChunkedEditor.value ? chunkedPreviewRef.value : previewRef.value)
    return sourceReady && previewReady
  },
  flushPendingContent() {
    const content = getEditablePreview()?.flushPendingMarkdownEmit?.() ?? getSourceChunkEditor()?.flushPendingMarkdownEmit?.()
    if (content !== undefined) emit('update:content', content, props.relativeFilePath)
  },
  scrollToHeading(target: MarkdownOutlineItem) {
    // An explicit jump takes precedence over deferred session restoration.
    restoreGeneration += 1
    if (viewMode.value !== 'editor') {
      if (useChunkedEditor.value) {
        chunkedPreviewRef.value?.scrollToHeading(target)
      } else {
        previewRef.value?.scrollToHeading(target)
      }
    }
    if (viewMode.value !== 'preview') {
      editorRef.value?.scrollToLine(target.line)
    }
  },
  scrollToLine(line: number) {
    restoreGeneration += 1
    if (viewMode.value !== 'editor') {
      if (useChunkedEditor.value) {
        chunkedPreviewRef.value?.scrollToLine(line)
      } else {
        previewRef.value?.scrollToLine(line)
      }
    }
    if (viewMode.value !== 'preview') {
      editorRef.value?.scrollToLine(line)
    }
  },
  saveSnapshot(skipSaveMeta = false) {
    saveSnapshot(skipSaveMeta)
  },
})
</script>

<template>
  <div ref="splitContainerRef" class="h-full w-full relative flex overflow-hidden">
    <div
      v-if="viewMode !== 'preview' && !isPartial && !isLoading"
      class="overflow-hidden"
      :class="viewMode === 'split' ? 'shrink-0' : 'flex-1'"
      :style="viewMode === 'split' ? { flexBasis: `${splitRatio * 100}%` } : undefined"
    >
      <ChunkedMarkdownEditor
        v-if="useChunkedEditor && chunkDocument"
        ref="editorRef"
        :content="props.content"
        :document-model="chunkDocument"
        :document-revision="chunkRevision"
        :file-path="props.filePath"
        :relative-file-path="props.relativeFilePath"
        :is-partial="isPartial"
        :is-loading-more="isLoadingMore"
        :is-loading-full-content="isPreparingFullContent || isBackgroundLoading"
        :total-bytes="totalBytes"
        :source-only="true"
        :show-line-numbers="settingsStore.showLineNumbers"
        :scroll-sync-enabled="viewMode === 'split'"
        @update:content="handleChunkContent"
        @save="handleChunkSave"
        @document-change="handleChunkChange"
        @edit-pending="emit('edit-pending', props.relativeFilePath)"
        @request-edit="requestChunkEdit"
        @scroll-sync="syncSplitScrollFromEditor"
      />
      <Editor
        v-else
        ref="editorRef"
        :initialContent="props.content"
        :filePath="props.filePath"
        :relativeFilePath="props.relativeFilePath"
        @change="(v) => emit('update:content', v, props.relativeFilePath)"
        @save="(v) => emit('save', v, props.relativeFilePath)"
        @scroll-sync="syncSplitScrollFromEditor"
      />
    </div>
    <div
      v-show="viewMode === 'split'"
      class="relative z-10 h-full w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent-soft active:bg-accent"
      style="-webkit-app-region: no-drag"
      @pointerdown="startSplitResize"
    />
    <div
      v-if="viewMode !== 'editor'"
      class="rich-text-zoom-scope relative flex-1 overflow-hidden"
      :class="{ 'border-l border-border-soft': viewMode === 'split' }"
      :style="{ '--rich-text-font-size': `${settingsStore.richTextZoom / 100}rem` }"
      @wheel="handleRichTextZoomWheel"
    >
      <div
        v-if="zoomIndicatorVisible"
        class="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2 rounded-lg border border-border-soft bg-panel/90 px-3 py-1.5 text-sm font-semibold text-text-main shadow-lg backdrop-blur-xs"
        role="status"
        aria-live="polite"
      >
        {{ settingsStore.richTextZoom }}%
      </div>
      <div v-if="isLoading" class="h-full flex items-center justify-center text-sm text-text-muted">
        正在加载笔记首屏内容...
      </div>
      <ChunkedMarkdownEditor
        v-else-if="useChunkedEditor && chunkDocument"
        ref="chunkedPreviewRef"
        :document-model="chunkDocument"
        :document-revision="chunkRevision"
        :scroll-sync-enabled="viewMode === 'split'"
        :content="props.content"
        :filePath="props.filePath"
        :relativeFilePath="props.relativeFilePath"
        :isPartial="isPartial"
        :isLoadingMore="isLoadingMore"
        :is-loading-full-content="isPreparingFullContent || isBackgroundLoading"
        :totalBytes="totalBytes"
        :show-line-numbers="settingsStore.showLineNumbers"
        @update:content="handleChunkContent"
        @save="handleChunkSave"
        @document-change="handleChunkChange"
        @edit-pending="emit('edit-pending', props.relativeFilePath)"
        @request-edit="requestChunkEdit"
        @load-more="emit('load-more')"
        @scroll-sync="syncSplitScrollFromPreview"
      />
      <TiptapPreview
        v-else
        ref="previewRef"
        :content="props.content"
        :filePath="props.filePath"
        :relativeFilePath="props.relativeFilePath"
        :show-line-numbers="settingsStore.showLineNumbers"
        @update:content="(v) => emit('update:content', v, props.relativeFilePath)"
        @save="(v) => emit('save', v, props.relativeFilePath)"
        @edit-pending="emit('edit-pending', props.relativeFilePath)"
        @scroll-sync="syncSplitScrollFromPreview"
      />
    </div>

    <div v-if="isPreparingFullContent || fullContentError" class="absolute top-3 left-1/2 -translate-x-1/2 z-20 rounded-lg border border-border-soft bg-panel/95 px-4 py-2 text-sm text-text-muted" role="status">
      <template v-if="fullContentError">
        {{ fullContentError }}
        <button class="ml-2 text-accent" @click="prepareFullContent()">重试</button>
      </template>
      <template v-else>正在加载完整笔记，完成后即可编辑…</template>
    </div>

    <div class="absolute bottom-6 right-6 flex items-center gap-1 bg-panel/90 backdrop-blur-xs p-1.5 rounded-xl border border-border-soft shadow-lg z-20">
      <button
        @click="setViewMode('editor')"
        :disabled="isPreparingFullContent"
        :class="[
          'p-2 rounded-lg transition-all duration-200',
          viewMode === 'editor' ? 'bg-accent-soft text-accent shadow-xs' : 'text-text-muted hover:text-text-main hover:bg-accent-soft'
        ]"
        title="编辑模式"
      >
        <Edit3 :size="18" />
      </button>
      <button
        @click="setViewMode('split')"
        :disabled="isPreparingFullContent"
        :class="[
          'p-2 rounded-lg transition-all duration-200',
          viewMode === 'split' ? 'bg-accent-soft text-accent shadow-xs' : 'text-text-muted hover:text-text-main hover:bg-accent-soft'
        ]"
        title="分割视图"
      >
        <Columns :size="18" />
      </button>
      <button
        @click="setViewMode('preview')"
        :class="[
          'p-2 rounded-lg transition-all duration-200',
          viewMode === 'preview' ? 'bg-accent-soft text-accent shadow-xs' : 'text-text-muted hover:text-text-main hover:bg-accent-soft'
        ]"
        title="预览模式"
      >
        <Eye :size="18" />
      </button>
    </div>

    <NoteLinkPreview v-if="!documentSession"
      :file-path="props.filePath"
      :relative-file-path="props.relativeFilePath"
    />
  </div>
</template>
