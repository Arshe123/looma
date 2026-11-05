<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { renderMarkdown } from '@/shared/utils/markdown-renderer'
import { getCodeHighlightSegments } from '@/shared/utils/markdown-code-highlight'
import '@/renderer/styles/rich-text-presentation.css'
import '../shared/code-block-presentation.css'

const props = defineProps<{
  content: string
}>()

const html = computed(() => renderMarkdown(props.content, { highlightCode: getCodeHighlightSegments }))

let resetTimer: number | null = null
let activeCopyButton: HTMLButtonElement | null = null

const setCopyButtonContent = (button: HTMLButtonElement, state: 'idle' | 'copied' | 'failed') => {
  const language = button.dataset.language?.trim() || 'text'
  button.classList.toggle('is-copied', state === 'copied')
  button.classList.toggle('is-failed', state === 'failed')
  button.replaceChildren()

  if (state === 'idle') {
    const languageLabel = document.createElement('span')
    languageLabel.className = 'code-block-copy-language'
    languageLabel.textContent = language

    const actionLabel = document.createElement('span')
    actionLabel.className = 'code-block-copy-action'
    actionLabel.textContent = '点击复制'

    button.append(languageLabel, actionLabel)
    return
  }

  const statusLabel = document.createElement('span')
  statusLabel.className = 'code-block-copy-status'
  statusLabel.textContent = state === 'copied' ? '已复制' : '复制失败'
  button.append(statusLabel)
}

const resetCopyButton = () => {
  if (!activeCopyButton) return
  setCopyButtonContent(activeCopyButton, 'idle')
  activeCopyButton = null
  resetTimer = null
}

const scheduleCopyReset = () => {
  if (resetTimer) window.clearTimeout(resetTimer)
  resetTimer = window.setTimeout(resetCopyButton, 1400)
}

const handleMarkdownClick = async (event: MouseEvent) => {
  const target = event.target
  if (!(target instanceof Element)) return

  const button = target.closest<HTMLButtonElement>('.code-block-floating-copy')
  if (!button) return

  event.preventDefault()
  event.stopPropagation()

  const shell = button.closest('.code-block-shell')
  const code = shell?.querySelector<HTMLElement>('.code-block-content')
  if (!code) return

  activeCopyButton = button
  try {
    await navigator.clipboard.writeText(code.textContent || '')
    setCopyButtonContent(button, 'copied')
  } catch (error) {
    setCopyButtonContent(button, 'failed')
  } finally {
    scheduleCopyReset()
  }
}

onBeforeUnmount(() => {
  if (resetTimer) window.clearTimeout(resetTimer)
})
</script>

<template>
  <div class="ai-markdown" @click="handleMarkdownClick" v-html="html" />
</template>

<style>
.ai-markdown {
  /* Chat keeps its compact scale, without editor gutters or writing-space padding. */
  --markdown-heading-margin: 0.9em 0 0.45em;
  --markdown-h1-size: 1.18em;
  --markdown-h2-size: 1.1em;
  --markdown-h3-size: 1em;
  --markdown-h5-size: 1em;
  --markdown-h6-size: 1em;
  color: inherit;
  background: transparent;
  font-family: var(--font-body);
  font-synthesis: style;
  font-size: inherit;
  line-height: inherit;
  user-select: text;
}

.ai-markdown > :first-child {
  margin-top: 0;
}

.ai-markdown > :last-child {
  margin-bottom: 0;
}

.ai-markdown .code-block-shell pre.code-block-body {
  /* No line-number gutter in chat. */
  padding-left: 1rem;
}

.ai-markdown .code-block-content {
  font-size: inherit;
  user-select: text;
}

.ai-markdown table {
  display: block;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  margin: 0.95em 0;
  overflow-x: auto;
  border-collapse: collapse;
}

/* markdown-it can put ordinary and task items in the same list. Only a pure
   task list loses its markers/gutter; mixed lists keep ordinary bullets. */
.ai-markdown ul.contains-task-list:not(:has(> li:not(.task-list-item))) {
  list-style: none;
  padding-left: 0;
}

.ai-markdown li.task-list-item {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
}

.ai-markdown .task-list-item-checkbox {
  margin-top: 0.35em;
  flex: 0 0 auto;
}

</style>
