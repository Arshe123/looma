<script setup lang="ts">
import { defineAsyncComponent, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { Columns, Edit3, Eye } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import { useSettingsStore } from '@/renderer/stores/settings'
import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'
import type TiptapPreviewComponent from '../preview/TiptapPreview.vue'
import type EditorComponent from './Editor.vue'
import type { ScrollSyncState } from '@/shared/types/ScrollSyncState'
import { isPrimaryModifierPressed } from '@/shared/utils/platform-shortcuts'
import { getNextRichTextZoom } from '@/shared/utils/rich-text-zoom'

const Editor = defineAsyncComponent(() => import('./Editor.vue'))
const TiptapPreview = defineAsyncComponent(() => import('../preview/TiptapPreview.vue'))
const ChunkedMarkdownPreview = defineAsyncComponent(() => import('../preview/ChunkedMarkdownPreview.vue'))
const NoteLinkPreview = defineAsyncComponent(() => import('../preview/NoteLinkPreview.vue'))

const props = defineProps<{
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
const settingsStore = useSettingsStore()
const viewMode = ref<'split' | 'editor' | 'preview'>('preview')
const splitRatio = ref(0.5)
const splitContainerRef = ref<HTMLElement | null>(null)
const editorRef = ref<InstanceType<typeof EditorComponent> | null>(null)
const previewRef = ref<InstanceType<typeof TiptapPreviewComponent> | null>(null)
const chunkedPreviewRef = ref<any>(null)
const isPreparingFullContent = ref(false)
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
  if (workspaceStore.isWorkspaceTransitioning) return
  const existing = workspaceStore.fileSessions[props.relativeFilePath]?.markdown
  workspaceStore.saveFileSession(props.relativeFilePath, {
    markdown: {
      viewMode: viewMode.value,
      splitRatio: splitRatio.value,
      editorScroll: existing?.editorScroll,
      previewScroll: existing?.previewScroll,
    },
  }, skipSaveMeta)
}

const getMarkdownSnapshot = () => {
  const existing = workspaceStore.fileSessions[props.relativeFilePath]?.markdown
  return {
    viewMode: viewMode.value,
    splitRatio: splitRatio.value,
    editorScroll: editorRef.value?.getScrollState?.() || existing?.editorScroll,
    previewScroll: getRenderedPreviewScrollState() || existing?.previewScroll,
  }
}

const saveSnapshot = (skipSaveMeta = false) => {
  if (workspaceStore.isWorkspaceTransitioning) return
  const cmSnap = editorRef.value?.getSnapshot()
  workspaceStore.saveFileSession(props.relativeFilePath, {
    markdown: getMarkdownSnapshot(),
    ...(cmSnap ? { codemirror: cmSnap } : {}),
  }, skipSaveMeta)
}

const restoreSnapshot = async (focusVisibleEditor = false) => {
  const generation = ++restoreGeneration
  const session = workspaceStore.fileSessions[props.relativeFilePath]
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
      if (focusVisibleEditor && viewMode.value === 'preview') {
        previewRef.value?.focus?.()
      }
    })
  })
}

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
  const previewState = props.useChunkedPreview
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
      if (props.useChunkedPreview) chunkedPreviewRef.value?.applyScrollState?.(state)
      else previewRef.value?.applyScrollState?.(state)
    }
  })
}

const syncSplitScrollFromEditor = (state: ScrollSyncState) => {
  if (viewMode.value !== 'split' || Date.now() < ignoreEditorScrollUntil) return
  ignorePreviewScrollUntil = Date.now() + SCROLL_SYNC_GUARD_MS
  if (props.useChunkedPreview) chunkedPreviewRef.value?.applyScrollState?.(state)
  else previewRef.value?.applyScrollState?.(state)
}

const syncSplitScrollFromPreview = (state: ScrollSyncState) => {
  if (viewMode.value !== 'split' || Date.now() < ignorePreviewScrollUntil) return
  ignoreEditorScrollUntil = Date.now() + SCROLL_SYNC_GUARD_MS
  editorRef.value?.applyScrollState?.(state)
}

const getRenderedPreviewScrollState = () => props.useChunkedPreview
  ? chunkedPreviewRef.value?.getScrollState?.()
  : previewRef.value?.getScrollState?.()

const applyRenderedPreviewScrollState = (state?: ScrollSyncState | null) => {
  if (!state) return
  if (props.useChunkedPreview) chunkedPreviewRef.value?.applyScrollState?.(state)
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

const setViewMode = async (nextMode: 'split' | 'editor' | 'preview') => {
  if (viewMode.value === nextMode) return
  if (nextMode !== 'preview' && (props.isPartial || props.isLoading)) {
    isPreparingFullContent.value = true
    const result = await workspaceStore.ensureTextFileFullyLoaded(props.relativeFilePath)
    isPreparingFullContent.value = false
    if (!result.success) return
  }
  const state = getCurrentScrollState()
  viewMode.value = nextMode
  nextTick(() => {
    requestAnimationFrame(() => syncVisibleViewsFrom(state))
  })
}

onMounted(async () => {
  const session = workspaceStore.fileSessions[props.relativeFilePath]
  if (session) {
    if (session.markdown?.viewMode) viewMode.value = session.markdown.viewMode
    if (typeof session.markdown?.splitRatio === 'number') splitRatio.value = clampSplitRatio(session.markdown.splitRatio)
    if (viewMode.value !== 'preview' && (props.isPartial || props.isLoading)) {
      isPreparingFullContent.value = true
      const result = await workspaceStore.ensureTextFileFullyLoaded(props.relativeFilePath)
      isPreparingFullContent.value = false
      if (!result.success) viewMode.value = 'preview'
    }
  }
  void restoreSnapshot(false)
})

onActivated(() => {
  if (!hasActivatedOnce) {
    hasActivatedOnce = true
    return
  }
  void restoreSnapshot(true)
})

onDeactivated(() => {
  restoreGeneration += 1
})

onUnmounted(() => {
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
    }
    const flushedContent = previewRef.value?.flushPendingMarkdownEmit?.()
    emit(
      'save',
      flushedContent ?? workspaceStore.openedTextFileContents[props.relativeFilePath]?.content ?? props.content,
      props.relativeFilePath,
    )
  },
)

defineExpose({
  scrollToHeading(target: MarkdownOutlineItem) {
    if (viewMode.value !== 'editor') {
      if (props.useChunkedPreview) {
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
    if (viewMode.value !== 'editor') {
      if (props.useChunkedPreview) {
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
      <Editor
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
      <ChunkedMarkdownPreview
        v-else-if="useChunkedPreview"
        ref="chunkedPreviewRef"
        :content="props.content"
        :filePath="props.filePath"
        :relativeFilePath="props.relativeFilePath"
        :isPartial="isPartial"
        :isLoadingMore="isLoadingMore"
        :totalBytes="totalBytes"
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

    <NoteLinkPreview
      :file-path="props.filePath"
      :relative-file-path="props.relativeFilePath"
    />
  </div>
</template>
