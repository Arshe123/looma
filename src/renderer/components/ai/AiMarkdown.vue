<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { renderMarkdown } from '@/shared/utils/markdown-renderer'

const props = defineProps<{
  content: string
}>()

const html = computed(() => renderMarkdown(props.content))

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
  color: inherit;
  background: transparent;
  font-family: inherit;
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

.ai-markdown p {
  margin: 0 0 0.65em;
}

.ai-markdown h1,
.ai-markdown h2,
.ai-markdown h3,
.ai-markdown h4,
.ai-markdown h5,
.ai-markdown h6 {
  margin: 0.9em 0 0.45em;
  color: inherit;
  font-weight: 700;
  line-height: 1.3;
}

.ai-markdown h1 {
  font-size: 1.18em;
}

.ai-markdown h2 {
  font-size: 1.1em;
}

.ai-markdown h3,
.ai-markdown h4,
.ai-markdown h5,
.ai-markdown h6 {
  font-size: 1em;
}

.ai-markdown ul,
.ai-markdown ol {
  margin: 0.45em 0 0.65em;
  padding-left: 1.35rem;
}

.ai-markdown ul {
  list-style-type: disc;
}

.ai-markdown ul ul {
  list-style-type: circle;
}

.ai-markdown ul ul ul {
  list-style-type: square;
}

.ai-markdown ol {
  list-style-type: decimal;
}

.ai-markdown li {
  display: list-item;
  margin: 0.2em 0;
}

.ai-markdown li > p {
  margin: 0.15em 0;
}

.ai-markdown a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.ai-markdown blockquote {
  margin: 0.75em 0;
  padding: 0.15em 0 0.15em 0.85rem;
  border-left: 3px solid var(--border-soft);
  color: var(--text-muted);
}

.ai-markdown code {
  border-radius: 4px;
  background: var(--panel-soft);
  padding: 0.12em 0.32em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.9em;
}

.ai-markdown .code-block-shell {
  margin: 0.95em 0;
  position: relative;
  overflow: hidden;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  color: #263241;
  background: #f7f9fc;
  box-shadow: 0 1px 0 color-mix(in srgb, var(--border-soft) 55%, transparent);
}

.ai-markdown .code-block-floating-copy {
  position: absolute;
  top: 0.55rem;
  right: 0.55rem;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: min(7.5rem, calc(100% - 1.1rem));
  min-width: 3.75rem;
  height: 1.65rem;
  padding: 0 0.55rem;
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.42);
  border-radius: 5px;
  color: #263241;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.12);
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1.25;
  opacity: 0;
  outline: none;
  pointer-events: none;
  text-overflow: ellipsis;
  transform: translateY(-2px);
  transition: opacity 120ms ease, transform 120ms ease, border-color 120ms ease, background-color 120ms ease, color 120ms ease;
  user-select: none;
  white-space: nowrap;
}

.ai-markdown .code-block-shell:hover .code-block-floating-copy,
.ai-markdown .code-block-shell:focus-within .code-block-floating-copy,
.ai-markdown .code-block-floating-copy:focus-visible {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.ai-markdown .code-block-floating-copy:hover,
.ai-markdown .code-block-floating-copy:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(255, 255, 255, 0.96);
}

.ai-markdown .code-block-copy-language,
.ai-markdown .code-block-copy-action,
.ai-markdown .code-block-copy-status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-markdown .code-block-copy-action {
  display: none;
}

.ai-markdown .code-block-floating-copy:hover .code-block-copy-language,
.ai-markdown .code-block-floating-copy:focus-visible .code-block-copy-language {
  display: none;
}

.ai-markdown .code-block-floating-copy:hover .code-block-copy-action,
.ai-markdown .code-block-floating-copy:focus-visible .code-block-copy-action {
  display: inline;
}

.ai-markdown .code-block-floating-copy.is-copied {
  border-color: color-mix(in srgb, var(--success, #16a34a) 45%, #c3ceda);
  color: var(--success, #16a34a);
}

.ai-markdown .code-block-floating-copy.is-failed {
  border-color: color-mix(in srgb, var(--danger, #dc2626) 45%, #c3ceda);
  color: var(--danger, #dc2626);
}

.ai-markdown .code-block-shell pre.code-block-body {
  margin: 0;
  min-height: 2.75rem;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.85rem 5.75rem 0.85rem 1rem;
  border: 0;
  border-radius: 0;
  color: inherit;
  background: transparent;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.92em;
  line-height: 1.55;
  white-space: pre;
}

.ai-markdown .code-block-content {
  display: block;
  margin: 0;
  color: inherit;
  background: transparent;
  padding: 0;
  tab-size: 2;
  white-space: pre !important;
  user-select: text;
}

.ai-markdown .code-block-content .hljs-keyword,
.ai-markdown .code-block-content .hljs-selector-tag,
.ai-markdown .code-block-content .hljs-built_in {
  color: #7c3aed;
}

.ai-markdown .code-block-content .hljs-string,
.ai-markdown .code-block-content .hljs-attr {
  color: #15803d;
}

.ai-markdown .code-block-content .hljs-title,
.ai-markdown .code-block-content .hljs-function,
.ai-markdown .code-block-content .hljs-name {
  color: #2563eb;
}

.ai-markdown .code-block-content .hljs-number,
.ai-markdown .code-block-content .hljs-literal,
.ai-markdown .code-block-content .hljs-symbol {
  color: #b45309;
}

.ai-markdown .code-block-content .hljs-comment,
.ai-markdown .code-block-content .hljs-quote {
  color: #6b7280;
  font-style: italic;
}

.ai-markdown table {
  display: block;
  width: 100%;
  margin: 0.75em 0;
  overflow-x: auto;
  border-collapse: collapse;
}

.ai-markdown th,
.ai-markdown td {
  border: 1px solid var(--border-soft);
  padding: 0.4rem 0.55rem;
  text-align: left;
  vertical-align: top;
}

.ai-markdown th {
  background: var(--panel-soft);
  font-weight: 700;
}

.ai-markdown ul.contains-task-list {
  list-style: none;
  padding-left: 0;
}

.ai-markdown .task-list-item {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
}

.ai-markdown .task-list-item-checkbox {
  margin-top: 0.35em;
  flex: 0 0 auto;
}

[data-theme="dark"] .ai-markdown .code-block-shell,
.dark .ai-markdown .code-block-shell {
  color: #d6e2f0;
  background: #0f1720;
}

[data-theme="dark"] .ai-markdown .code-block-floating-copy,
.dark .ai-markdown .code-block-floating-copy {
  border-color: rgba(148, 163, 184, 0.36);
  color: #d6e2f0;
  background: rgba(15, 23, 32, 0.82);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.24);
}

[data-theme="dark"] .ai-markdown .code-block-floating-copy:hover,
.dark .ai-markdown .code-block-floating-copy:hover,
[data-theme="dark"] .ai-markdown .code-block-floating-copy:focus-visible,
.dark .ai-markdown .code-block-floating-copy:focus-visible {
  color: #8fb7ff;
  background: rgba(23, 32, 43, 0.96);
}
</style>
