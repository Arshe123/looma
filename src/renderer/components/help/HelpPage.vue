<script setup lang="ts">
import { computed, ref } from 'vue'
import { renderMarkdown } from '@/shared/utils/markdown-renderer'
import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'
import helpMarkdown from './help.md?raw'

const html = computed(() => renderMarkdown(helpMarkdown))
const articleRef = ref<HTMLElement | null>(null)

const scrollToHeading = (target: MarkdownOutlineItem) => {
  const headings = Array.from(articleRef.value?.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6') || [])
  const heading = headings[target.index]
  if (!heading) return false
  heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return true
}

defineExpose({ scrollToHeading })

const handleContentClick = (event: MouseEvent) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const anchor = target.closest<HTMLAnchorElement>('a[href]')
  const href = anchor?.href
  if (!href || !/^https?:\/\//i.test(href)) return
  event.preventDefault()
  void window.electronAPI.app.openExternal(href)
}
</script>

<template>
  <main class="flex-1 min-h-0 overflow-y-auto bg-panel">
    <article
      ref="articleRef"
      class="help-markdown w-full max-w-3xl mx-auto px-10 py-9"
      @click="handleContentClick"
      v-html="html"
    />
  </main>
</template>

<style scoped>
.help-markdown {
  color: var(--text-main);
  font-size: 14px;
  line-height: 1.75;
  user-select: text;
}

.help-markdown :deep(> :first-child) { margin-top: 0; }
.help-markdown :deep(> :last-child) { margin-bottom: 0; }
.help-markdown :deep(h1) { margin: 0 0 1rem; font-size: 1.7rem; line-height: 1.3; }
.help-markdown :deep(h2) { margin: 1.7rem 0 0.65rem; padding-bottom: 0.35rem; border-bottom: 1px solid var(--border-soft); font-size: 1.18rem; line-height: 1.4; }
.help-markdown :deep(h3) { margin: 1.2rem 0 0.45rem; font-size: 1rem; }
.help-markdown :deep(p) { margin: 0.55rem 0; color: var(--text-muted); }
.help-markdown :deep(ul),
.help-markdown :deep(ol) { margin: 0.55rem 0; padding-left: 1.45rem; color: var(--text-muted); }
.help-markdown :deep(ul) { list-style: disc; }
.help-markdown :deep(ol) { list-style: decimal; }
.help-markdown :deep(li) { margin: 0.25rem 0; }
.help-markdown :deep(a) { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.help-markdown :deep(code) { border-radius: 4px; background: var(--panel-soft); padding: 0.15em 0.35em; color: var(--text-main); font-size: 0.9em; }
.help-markdown :deep(strong) { color: var(--text-main); }
</style>
