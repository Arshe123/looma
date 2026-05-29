<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Columns, Edit3, Eye } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/store/workspace'
import type { MarkdownOutlineItem } from '@/common/interface/MarkdownOutlineItem'
import TiptapPreview from '../preview/TiptapPreview.vue'
import Editor from './Editor.vue'
import type { ScrollSyncState } from '@/common/type/ScrollSyncState'

const props = defineProps<{
  filePath: string
  relativeFilePath: string
  content: string
  saveTrigger: number
}>()

const emit = defineEmits<{
  (e: 'update:content', value: string): void
  (e: 'save', value: string): void
}>()

const workspaceStore = useWorkspaceStore()
const viewMode = ref<'split' | 'editor' | 'preview'>('preview')
const splitRatio = ref(0.5)
const splitContainerRef = ref<HTMLElement | null>(null)
const editorRef = ref<InstanceType<typeof Editor> | null>(null)
const previewRef = ref<InstanceType<typeof TiptapPreview> | null>(null)
let isResizingSplit = false
let previousBodyCursor = ''
let previousBodyUserSelect = ''
let isSyncingScroll = false

const clampSplitRatio = (ratio: number) => Math.min(Math.max(ratio, 0.2), 0.8)

const saveMarkdownSession = (skipSaveMeta = false) => {
  if (workspaceStore.isWorkspaceTransitioning) return
  workspaceStore.saveFileSession(props.relativeFilePath, {
    markdown: {
      viewMode: viewMode.value,
      splitRatio: splitRatio.value,
    },
  }, skipSaveMeta)
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
  if (viewMode.value === 'preview') return previewRef.value?.getScrollState?.()
  return editorRef.value?.getScrollState?.() || previewRef.value?.getScrollState?.()
}

const syncVisibleViewsFrom = (state?: ScrollSyncState | null) => {
  if (!state) return
  withScrollSync(() => {
    if (viewMode.value !== 'preview') {
      editorRef.value?.applyScrollState?.(state)
    }
    if (viewMode.value !== 'editor') {
      previewRef.value?.applyScrollState?.(state)
    }
  })
}

const setViewMode = (nextMode: 'split' | 'editor' | 'preview') => {
  if (viewMode.value === nextMode) return
  const state = getCurrentScrollState()
  viewMode.value = nextMode
  nextTick(() => {
    requestAnimationFrame(() => syncVisibleViewsFrom(state))
  })
}

onMounted(() => {
  const session = workspaceStore.fileSessions[props.relativeFilePath]
  if (session) {
    if (session.markdown?.viewMode) viewMode.value = session.markdown.viewMode
    if (typeof session.markdown?.splitRatio === 'number') splitRatio.value = clampSplitRatio(session.markdown.splitRatio)
    if (session.codemirror && editorRef.value) {
      setTimeout(() => editorRef.value?.applySnapshot(session.codemirror!), 50)
    }
  }
})

onUnmounted(() => {
  stopSplitResize()
})

watch(viewMode, () => {
  saveMarkdownSession()
})

watch(
  () => props.saveTrigger,
  () => {
    const flushedContent = previewRef.value?.flushPendingMarkdownEmit?.()
    emit('save', flushedContent ?? props.content)
  },
)

defineExpose({
  scrollToHeading(target: MarkdownOutlineItem) {
    if (viewMode.value !== 'editor') {
      previewRef.value?.scrollToHeading(target)
    }
    if (viewMode.value !== 'preview') {
      editorRef.value?.scrollToLine(target.line)
    }
  },
  saveSnapshot(skipSaveMeta = false) {
    if (workspaceStore.isWorkspaceTransitioning) return
    const cmSnap = editorRef.value?.getSnapshot()
    if (cmSnap && props.relativeFilePath) {
      workspaceStore.saveFileSession(props.relativeFilePath, {
        markdown: {
          viewMode: viewMode.value,
          splitRatio: splitRatio.value,
        },
        codemirror: cmSnap,
      }, skipSaveMeta)
    } else {
      saveMarkdownSession(skipSaveMeta)
    }
  },
})
</script>

<template>
  <div ref="splitContainerRef" class="h-full w-full relative flex overflow-hidden">
    <div
      v-show="viewMode !== 'preview'"
      class="overflow-hidden"
      :class="viewMode === 'split' ? 'shrink-0' : 'flex-1'"
      :style="viewMode === 'split' ? { flexBasis: `${splitRatio * 100}%` } : undefined"
    >
      <Editor
        ref="editorRef"
        :initialContent="props.content"
        :filePath="props.filePath"
        @change="(v) => emit('update:content', v)"
        @save="(v) => emit('save', v)"
      />
    </div>
    <div
      v-show="viewMode === 'split'"
      class="relative z-10 h-full w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent-soft active:bg-accent"
      style="-webkit-app-region: no-drag"
      @pointerdown="startSplitResize"
    />
    <div v-show="viewMode !== 'editor'" class="flex-1 overflow-hidden" :class="{ 'border-l border-border-soft': viewMode === 'split' }">
      <TiptapPreview
        ref="previewRef"
        :content="props.content"
        :filePath="props.filePath"
        :relativeFilePath="props.relativeFilePath"
        @update:content="(v) => emit('update:content', v)"
      />
    </div>

    <div class="absolute bottom-6 right-6 flex items-center gap-1 bg-panel/90 backdrop-blur-xs p-1.5 rounded-xl border border-border-soft shadow-lg z-20">
      <button
        @click="setViewMode('editor')"
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
  </div>
</template>
