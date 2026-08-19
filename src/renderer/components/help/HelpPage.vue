<script setup lang="ts">
import { computed, ref } from 'vue'
import { renderMarkdown } from '@/shared/utils/markdown-renderer'
import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'
import helpMarkdown from './help.md?raw'
import 'github-markdown-css/github-markdown-light.css'

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
      class="help-markdown markdown-body w-full max-w-3xl mx-auto px-10 py-9"
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
  background-color: transparent !important;
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

/* 补充 github-markdown-css 未覆盖或需要主题适配的元素 */
.help-markdown :deep(blockquote) {
  margin: 0.55rem 0;
  padding: 0.25rem 0 0.25rem 1rem;
  border-left: 4px solid var(--border-soft);
  color: var(--text-muted);
  background: var(--panel-soft);
  border-radius: 0 4px 4px 0;
}
.help-markdown :deep(blockquote p) { margin: 0; color: inherit; }

.help-markdown :deep(pre) {
  margin: 0.85rem 0;
  padding: 0.85rem 1rem;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  color: var(--text-main);
  background: var(--panel-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.92em;
  line-height: 1.55;
}
.help-markdown :deep(pre code) {
  margin: 0;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  tab-size: 2;
}

.help-markdown :deep(table) {
  width: max-content;
  min-width: 100%;
  margin: 0.95rem 0;
  border-collapse: collapse;
  table-layout: auto;
}
.help-markdown :deep(table td),
.help-markdown :deep(table th) {
  min-width: 7.5rem;
  border: 1px solid var(--border-soft);
  padding: 0.5rem 0.65rem;
  vertical-align: top;
  box-sizing: border-box;
  background: var(--panel);
}
.help-markdown :deep(table th) {
  font-weight: bold;
  text-align: left;
  background-color: var(--panel-soft);
}

.help-markdown :deep(img) {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0.85rem 0;
  border-radius: 6px;
}

.help-markdown :deep(mark) {
  background: var(--accent-soft);
  color: var(--text-main);
  padding: 0.1em 0.2em;
  border-radius: 3px;
}

.help-markdown :deep(del) { color: var(--text-subtle); }
.help-markdown :deep(hr) {
  margin: 1.5rem 0;
  border: none;
  border-top: 1px solid var(--border-soft);
}
</style>
