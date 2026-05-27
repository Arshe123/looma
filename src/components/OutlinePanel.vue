<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useWorkspaceStore } from '../store/workspace'
import type { MarkdownOutlineItem } from '@/common/interface/MarkdownOutlineItem'
import type { OutlineFlatRow } from '@/common/util/outline-tree'

const workspaceStore = useWorkspaceStore()
const expandedHeadingIds = ref(new Set<string>())
const knownHeadingIds = ref(new Set<string>())
const lastActivePath = ref('')
const outlineItems = ref<MarkdownOutlineItem[]>([])
const visibleRows = ref<OutlineFlatRow[]>([])
const isOutlineLoading = ref(false)
const outlineError = ref('')
let outlineWorker: Worker | null = null
let activeRequestId = 0

const isMarkdownActive = computed(() => workspaceStore.activeFileRelativePath.toLowerCase().endsWith('.md'))

type MarkdownOutlineWorkerSuccess = {
  requestId: number
  success: true
  items: MarkdownOutlineItem[]
  visibleRows: OutlineFlatRow[]
  expandedIds: string[]
  knownIds: string[]
}

type MarkdownOutlineWorkerFailure = {
  requestId: number
  success: false
  error: string
}

type MarkdownOutlineWorkerResponse = MarkdownOutlineWorkerSuccess | MarkdownOutlineWorkerFailure

const resetOutlineState = () => {
  outlineItems.value = []
  visibleRows.value = []
  expandedHeadingIds.value = new Set()
  knownHeadingIds.value = new Set()
  outlineError.value = ''
  isOutlineLoading.value = false
}

const ensureOutlineWorker = () => {
  if (outlineWorker) return outlineWorker
  if (typeof Worker === 'undefined') return null

  outlineWorker = new Worker(new URL('../workers/markdown-outline.worker.ts', import.meta.url), { type: 'module' })
  outlineWorker.onmessage = (event: MessageEvent<MarkdownOutlineWorkerResponse>) => {
    const response = event.data
    if (response.requestId !== activeRequestId) return

    isOutlineLoading.value = false
    if (response.success === false) {
      outlineError.value = response.error
      outlineItems.value = []
      visibleRows.value = []
      return
    }

    outlineError.value = ''
    outlineItems.value = response.items
    visibleRows.value = response.visibleRows
    expandedHeadingIds.value = new Set(response.expandedIds)
    knownHeadingIds.value = new Set(response.knownIds)
  }
  outlineWorker.onerror = (event) => {
    isOutlineLoading.value = false
    outlineError.value = event.message || '大纲生成失败。'
    outlineItems.value = []
    visibleRows.value = []
  }

  return outlineWorker
}

const requestOutline = (content: string, resetExpansion: boolean) => {
  const worker = ensureOutlineWorker()
  const requestId = activeRequestId + 1
  activeRequestId = requestId
  outlineError.value = ''
  isOutlineLoading.value = true

  if (resetExpansion) {
    outlineItems.value = []
    visibleRows.value = []
    expandedHeadingIds.value = new Set()
    knownHeadingIds.value = new Set()
  }

  worker?.postMessage({
    requestId,
    content,
    expandedIds: Array.from(expandedHeadingIds.value),
    knownIds: Array.from(knownHeadingIds.value),
    resetExpansion,
  })
}

watch(
  () => [workspaceStore.activeFileRelativePath, workspaceStore.activeFileContent] as const,
  ([activePath, content]) => {
    activeRequestId += 1

    if (!activePath.toLowerCase().endsWith('.md')) {
      lastActivePath.value = activePath
      resetOutlineState()
      return
    }

    const resetExpansion = activePath !== lastActivePath.value
    lastActivePath.value = activePath
    requestOutline(content, resetExpansion)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  activeRequestId += 1
  outlineWorker?.terminate()
  outlineWorker = null
})

const isExpanded = (id: string) => expandedHeadingIds.value.has(id)

const toggleHeading = (id: string) => {
  const nextExpanded = new Set(expandedHeadingIds.value)
  if (nextExpanded.has(id)) {
    nextExpanded.delete(id)
  } else {
    nextExpanded.add(id)
  }
  expandedHeadingIds.value = nextExpanded
  requestOutline(workspaceStore.activeFileContent, false)
}

const jumpToHeading = (item: MarkdownOutlineItem) => {
  window.dispatchEvent(new CustomEvent('looma:jump-to-heading', { detail: item }))
}
</script>

<template>
  <div class="h-full min-h-0 flex flex-col">
    <div class="shrink-0 px-4 py-3 text-sm font-semibold text-text-main">
      大纲
    </div>

    <div class="min-h-0 flex-1 overflow-hidden">
      <div v-if="!isMarkdownActive" class="h-full p-4 text-sm text-text-muted">
        大纲仅支持 Markdown 文件。
      </div>
      <div v-else-if="isOutlineLoading && outlineItems.length === 0" class="h-full p-4 text-sm text-text-muted">
        大纲加载中...
      </div>
      <div v-else-if="outlineError" class="h-full p-4 text-sm text-text-muted">
        {{ outlineError }}
      </div>
      <div v-else-if="outlineItems.length === 0" class="h-full p-4 text-sm text-text-muted">
        当前 Markdown 文件暂无标题。
      </div>
      <div v-else class="h-full overflow-y-auto focus-scrollbar py-2">
        <div
          v-for="row in visibleRows"
          :key="row.item.id"
          class="group relative w-full min-h-8 pr-3 py-1.5 flex items-start gap-2 text-left text-sm text-text-muted hover:bg-accent-soft hover:text-text-main"
          :style="{ paddingLeft: `${10 + row.depth * 14}px` }"
          :title="row.item.text"
        >
          <span
            v-for="(guide, guideIndex) in row.guides"
            :key="guideIndex"
            class="pointer-events-none absolute top-0 border-l border-border-soft"
            :class="guide === 'none' ? 'hidden' : guide === 'continue' ? 'h-full' : 'h-1/2'"
            :style="{ left: `${10 + guideIndex * 14 + 7}px` }"
          ></span>
          <button
            v-if="row.children.length > 0"
            class="relative z-10 -mt-0.5 w-5 h-6 shrink-0 inline-flex items-center justify-center rounded hover:bg-accent-soft text-text-muted"
            @click.stop="toggleHeading(row.item.id)"
          >
            <ChevronRight
              :size="14"
              :class="['transition-transform', isExpanded(row.item.id) ? 'rotate-90' : 'rotate-0']"
            />
          </button>
          <div v-else class="w-5 h-6 shrink-0"></div>
          <button
            class="relative z-10 min-w-0 flex-1 truncate text-left cursor-pointer"
            @click="jumpToHeading(row.item)"
          >
            {{ row.item.text }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
