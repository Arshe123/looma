<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

const props = defineProps(nodeViewProps)

const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
let resetTimer: number | null = null

const displayLanguage = computed(() => {
  const language = typeof props.node.attrs.language === 'string'
    ? props.node.attrs.language.trim()
    : ''

  return language || 'text'
})

const copyStatusLabel = computed(() => {
  if (copyState.value === 'copied') return '已复制'
  if (copyState.value === 'failed') return '复制失败'
  return ''
})

const resetCopyState = () => {
  if (resetTimer) window.clearTimeout(resetTimer)
  resetTimer = window.setTimeout(() => {
    copyState.value = 'idle'
    resetTimer = null
  }, 1400)
}

const copyCode = async () => {
  try {
    await navigator.clipboard.writeText(props.node.textContent)
    copyState.value = 'copied'
  } catch (error) {
    copyState.value = 'failed'
  } finally {
    resetCopyState()
  }
}

onBeforeUnmount(() => {
  if (resetTimer) window.clearTimeout(resetTimer)
})
</script>

<template>
  <NodeViewWrapper class="code-block-shell">
    <button
      type="button"
      class="code-block-floating-copy"
      :class="{ 'is-copied': copyState === 'copied', 'is-failed': copyState === 'failed' }"
      contenteditable="false"
      :aria-label="`复制 ${displayLanguage} 代码`"
      @click.prevent.stop="copyCode"
    >
      <template v-if="copyState === 'idle'">
        <span class="code-block-copy-language">{{ displayLanguage }}</span>
        <span class="code-block-copy-action">点击复制</span>
      </template>
      <span v-else class="code-block-copy-status">{{ copyStatusLabel }}</span>
    </button>
    <pre class="code-block-body"><NodeViewContent as="code" class="code-block-content" /></pre>
  </NodeViewWrapper>
</template>

<style>
.tiptap .code-block-shell,
.markdown-body .code-block-shell {
  margin: 0.95em 0;
  position: relative;
  overflow: hidden;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  color: #263241;
  background: #f7f9fc;
  box-shadow: 0 1px 0 color-mix(in srgb, var(--border-soft) 55%, transparent);
}

.tiptap .code-block-floating-copy,
.markdown-body .code-block-floating-copy {
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

.tiptap .code-block-shell:hover .code-block-floating-copy,
.markdown-body .code-block-shell:hover .code-block-floating-copy,
.tiptap .code-block-shell:focus-within .code-block-floating-copy,
.markdown-body .code-block-shell:focus-within .code-block-floating-copy,
.tiptap .code-block-floating-copy:focus-visible,
.markdown-body .code-block-floating-copy:focus-visible {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.tiptap .code-block-floating-copy:hover,
.markdown-body .code-block-floating-copy:hover,
.tiptap .code-block-floating-copy:focus-visible,
.markdown-body .code-block-floating-copy:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(255, 255, 255, 0.96);
}

.tiptap .code-block-copy-language,
.markdown-body .code-block-copy-language,
.tiptap .code-block-copy-action,
.markdown-body .code-block-copy-action,
.tiptap .code-block-copy-status,
.markdown-body .code-block-copy-status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tiptap .code-block-copy-action,
.markdown-body .code-block-copy-action {
  display: none;
}

.tiptap .code-block-floating-copy:hover .code-block-copy-language,
.markdown-body .code-block-floating-copy:hover .code-block-copy-language,
.tiptap .code-block-floating-copy:focus-visible .code-block-copy-language,
.markdown-body .code-block-floating-copy:focus-visible .code-block-copy-language {
  display: none;
}

.tiptap .code-block-floating-copy:hover .code-block-copy-action,
.markdown-body .code-block-floating-copy:hover .code-block-copy-action,
.tiptap .code-block-floating-copy:focus-visible .code-block-copy-action,
.markdown-body .code-block-floating-copy:focus-visible .code-block-copy-action {
  display: inline;
}

.tiptap .code-block-floating-copy.is-copied,
.markdown-body .code-block-floating-copy.is-copied {
  border-color: color-mix(in srgb, var(--success, #16a34a) 45%, #c3ceda);
  color: var(--success, #16a34a);
}

.tiptap .code-block-floating-copy.is-failed,
.markdown-body .code-block-floating-copy.is-failed {
  border-color: color-mix(in srgb, var(--danger, #dc2626) 45%, #c3ceda);
  color: var(--danger, #dc2626);
}

.tiptap .code-block-shell pre.code-block-body,
.markdown-body .code-block-shell pre.code-block-body {
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

.tiptap .code-block-content,
.markdown-body .code-block-content {
  display: block;
  margin: 0;
  padding: 0;
  color: inherit;
  background: transparent;
  tab-size: 2;
  white-space: pre !important;
}

.tiptap .code-block-content:empty::before {
  content: "\200b";
}

.tiptap .code-block-content br.ProseMirror-trailingBreak {
  display: inline;
}

.tiptap .code-block-content .hljs-keyword,
.markdown-body .code-block-content .hljs-keyword,
.tiptap .code-block-content .hljs-selector-tag,
.markdown-body .code-block-content .hljs-selector-tag,
.tiptap .code-block-content .hljs-built_in,
.markdown-body .code-block-content .hljs-built_in {
  color: #7c3aed;
}

.tiptap .code-block-content .hljs-string,
.markdown-body .code-block-content .hljs-string,
.tiptap .code-block-content .hljs-attr,
.markdown-body .code-block-content .hljs-attr {
  color: #15803d;
}

.tiptap .code-block-content .hljs-title,
.markdown-body .code-block-content .hljs-title,
.tiptap .code-block-content .hljs-function,
.markdown-body .code-block-content .hljs-function,
.tiptap .code-block-content .hljs-name,
.markdown-body .code-block-content .hljs-name {
  color: #2563eb;
}

.tiptap .code-block-content .hljs-number,
.markdown-body .code-block-content .hljs-number,
.tiptap .code-block-content .hljs-literal,
.markdown-body .code-block-content .hljs-literal,
.tiptap .code-block-content .hljs-symbol,
.markdown-body .code-block-content .hljs-symbol {
  color: #b45309;
}

.tiptap .code-block-content .hljs-comment,
.markdown-body .code-block-content .hljs-comment,
.tiptap .code-block-content .hljs-quote,
.markdown-body .code-block-content .hljs-quote {
  color: #6b7280;
  font-style: italic;
}

[data-theme="dark"] .tiptap .code-block-shell,
.dark .tiptap .code-block-shell,
[data-theme="dark"] .markdown-body .code-block-shell,
.dark .markdown-body .code-block-shell {
  color: #d6e2f0;
  background: #0f1720;
}

[data-theme="dark"] .tiptap .code-block-floating-copy,
.dark .tiptap .code-block-floating-copy,
[data-theme="dark"] .markdown-body .code-block-floating-copy,
.dark .markdown-body .code-block-floating-copy {
  border-color: rgba(148, 163, 184, 0.36);
  color: #d6e2f0;
  background: rgba(15, 23, 32, 0.82);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.24);
}

[data-theme="dark"] .tiptap .code-block-floating-copy:hover,
.dark .tiptap .code-block-floating-copy:hover,
[data-theme="dark"] .markdown-body .code-block-floating-copy:hover,
.dark .markdown-body .code-block-floating-copy:hover,
[data-theme="dark"] .tiptap .code-block-floating-copy:focus-visible,
.dark .tiptap .code-block-floating-copy:focus-visible,
[data-theme="dark"] .markdown-body .code-block-floating-copy:focus-visible,
.dark .markdown-body .code-block-floating-copy:focus-visible {
  color: #8fb7ff;
  background: rgba(23, 32, 43, 0.96);
}
</style>
