<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { useWorkspaceStore } from '../store/workspace'
import { parseMarkdownOutline, type MarkdownOutlineItem } from './util/markdown-outline'
import { buildOutlineTree, flattenOutlineTree } from './util/outline-tree'

const workspaceStore = useWorkspaceStore()
const expandedHeadingIds = ref(new Set<string>())
const knownHeadingIds = ref(new Set<string>())
const lastActivePath = ref('')

const isMarkdownActive = computed(() => workspaceStore.activeFileRelativePath.toLowerCase().endsWith('.md'))
const outlineItems = computed(() => {
  if (!isMarkdownActive.value) return []
  return parseMarkdownOutline(workspaceStore.activeFileContent)
})
const outlineTree = computed(() => buildOutlineTree(outlineItems.value))
const visibleRows = computed(() => flattenOutlineTree(outlineTree.value, expandedHeadingIds.value))

watch(
  () => [workspaceStore.activeFileRelativePath, outlineItems.value] as const,
  ([activePath, items]) => {
    const ids = new Set(items.map((item) => item.id))
    if (activePath !== lastActivePath.value) {
      expandedHeadingIds.value = ids
      knownHeadingIds.value = ids
      lastActivePath.value = activePath
      return
    }

    const nextExpanded = new Set([...expandedHeadingIds.value].filter((id) => ids.has(id)))
    ids.forEach((id) => {
      if (!knownHeadingIds.value.has(id)) nextExpanded.add(id)
    })
    expandedHeadingIds.value = nextExpanded
    knownHeadingIds.value = ids
  },
  { immediate: true },
)

const isExpanded = (id: string) => expandedHeadingIds.value.has(id)

const toggleHeading = (id: string) => {
  const nextExpanded = new Set(expandedHeadingIds.value)
  if (nextExpanded.has(id)) {
    nextExpanded.delete(id)
  } else {
    nextExpanded.add(id)
  }
  expandedHeadingIds.value = nextExpanded
}

const jumpToHeading = (item: MarkdownOutlineItem) => {
  window.dispatchEvent(new CustomEvent('looma:jump-to-heading', { detail: item }))
}
</script>

<template>
  <div class="h-full min-h-0 overflow-hidden">
    <div v-if="!isMarkdownActive" class="h-full p-4 text-sm text-text-muted">
      大纲仅支持 Markdown 文件。
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
</template>
