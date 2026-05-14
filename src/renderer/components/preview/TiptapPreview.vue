<script setup lang="ts">
import { shallowRef, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { Highlight } from '@tiptap/extension-highlight'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import { Markdown } from 'tiptap-markdown'
import 'github-markdown-css/github-markdown-light.css'
import 'highlight.js/styles/github-dark.css'
import InlineMenu from './InlineMenu.vue'
import ContextMenu from './ContextMenu.vue'
import { replaceExternalMarkdownContent } from './tiptap-content-sync'

const props = defineProps<{
  content: string
}>()

const emit = defineEmits<{
  (e: 'update:content', value: string): void
}>()

let isUpdatingFromExternal = false
let lastEmittedContent = ''

const editor = shallowRef<Editor | null>(null)

onMounted(() => {
  editor.value = new Editor({
    extensions: [
      StarterKit.configure({
        codeBlock: {
          exitOnTripleEnter: false,
          exitOnArrowDown: true,
        },
        bulletList: { keepMarks: true, keepAttributes: false },
        orderedList: { keepMarks: true, keepAttributes: false },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight,
      TextStyle,
      Color,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({
        placeholder: 'Shift + ctrl + Enter 唤起菜单，或直接输入 Markdown...',
      }),
      Markdown.configure({
        html: true,
        transformPastedText: true,
      }),
    ],
    content: props.content,
    editorProps: {
      attributes: {
        class: 'prose dark:prose-invert max-w-none focus:outline-hidden min-h-full p-8 markdown-body dark:markdown-body-dark',
      },
    },
    onUpdate: ({ editor }) => {
      if (isUpdatingFromExternal) return
      const markdown = (editor.storage as any).markdown.getMarkdown()
      lastEmittedContent = markdown
      emit('update:content', markdown)
    },
  })
})

onBeforeUnmount(() => {
  if (editor.value) {
    editor.value.destroy()
  }
})

watch(
  () => props.content,
  (newContent) => {
    if (!editor.value) return
    if (newContent === lastEmittedContent) return
    
    isUpdatingFromExternal = true
    const { from, to } = editor.value.state.selection
    replaceExternalMarkdownContent(editor.value as any, newContent)
    
    // Try to restore selection if possible
    try {
      editor.value.commands.setTextSelection({ from, to })
    } catch (e) {
      // Ignore
    }
    
    nextTick(() => {
      isUpdatingFromExternal = false
    })
  }
)


</script>

<template>
  <div class="h-full w-full bg-panel overflow-y-auto relative tiptap-preview-container tiptap-editor-wrapper focus-scrollbar">
    <editor-content v-if="editor" :editor="editor" class="h-full" />
    
    <InlineMenu v-if="editor" :editor="editor" />
    <ContextMenu v-if="editor" :editor="editor" />
  </div>
</template>

<style>
.tiptap-preview-container {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
.markdown-body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  line-height: 1.6;
  color: var(--text-main);
  background-color: transparent !important;
  padding-bottom: calc(2rem + 22vh) !important;
}

.markdown-body a {
  color: var(--accent);
}

[data-theme="dark"] .markdown-body,
.dark .markdown-body {
  color: var(--text-main);
  background-color: transparent !important;
}

.markdown-body p {
  margin-bottom: 0.6em;
}

.tiptap pre,
.markdown-body pre {
  margin: 0.85em 0;
  padding: 0.85rem 1rem;
  min-height: 2.75rem;
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

.tiptap pre code,
.markdown-body pre code {
  margin: 0;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  tab-size: 2;
}

.tiptap pre code:empty::before {
  content: "\200b";
}

.tiptap pre code br.ProseMirror-trailingBreak {
  display: inline;
}

.tiptap h1::after,
.tiptap h2::after,
.tiptap h3::after,
.tiptap h4::after,
.tiptap h5::after,
.tiptap h6::after,
.markdown-body h1::after,
.markdown-body h2::after,
.markdown-body h3::after,
.markdown-body h4::after,
.markdown-body h5::after,
.markdown-body h6::after {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 0.5rem;
  padding: 0.05rem 0.3rem;
  min-width: 1.35rem;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  color: var(--text-muted);
  background: var(--panel-soft);
  font-size: 0.65rem;
  font-weight: 600;
  line-height: 1.2;
  vertical-align: middle;
  visibility: hidden;
  opacity: 0;
  transition: opacity 120ms ease;
  pointer-events: none;
  user-select: none;
}

.tiptap h1:hover::after,
.tiptap h2:hover::after,
.tiptap h3:hover::after,
.tiptap h4:hover::after,
.tiptap h5:hover::after,
.tiptap h6:hover::after,
.tiptap h1:focus-within::after,
.tiptap h2:focus-within::after,
.tiptap h3:focus-within::after,
.tiptap h4:focus-within::after,
.tiptap h5:focus-within::after,
.tiptap h6:focus-within::after,
.markdown-body h1:hover::after,
.markdown-body h2:hover::after,
.markdown-body h3:hover::after,
.markdown-body h4:hover::after,
.markdown-body h5:hover::after,
.markdown-body h6:hover::after,
.markdown-body h1:focus-within::after,
.markdown-body h2:focus-within::after,
.markdown-body h3:focus-within::after,
.markdown-body h4:focus-within::after,
.markdown-body h5:focus-within::after,
.markdown-body h6:focus-within::after {
  visibility: visible;
  opacity: 1;
}

.tiptap h1::after,
.markdown-body h1::after {
  content: "H1";
}
.tiptap h2::after,
.markdown-body h2::after {
  content: "H2";
}
.tiptap h3::after,
.markdown-body h3::after {
  content: "H3";
}
.tiptap h4::after,
.markdown-body h4::after {
  content: "H4";
}
.tiptap h5::after,
.markdown-body h5::after {
  content: "H5";
}
.tiptap h6::after,
.markdown-body h6::after {
  content: "H6";
}

.markdown-body-dark {
  background-color: transparent !important;
}
.tiptap p.is-editor-empty:first-child::before {
  color: var(--text-subtle);
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
}
.tiptap table {
  border-collapse: collapse;
  table-layout: fixed;
  width: 100%;
  margin: 0;
  overflow: hidden;
}
.tiptap table td,
.tiptap table th {
  min-width: 1em;
  border: 1px solid var(--border-soft);
  padding: 3px 5px;
  vertical-align: top;
  box-sizing: border-box;
  position: relative;
}
.tiptap table th {
  font-weight: bold;
  text-align: left;
  background-color: var(--panel-soft);
}
[data-theme="dark"] .tiptap table td,
[data-theme="dark"] .tiptap table th,
.dark .tiptap table td,
.dark .tiptap table th {
  border-color: var(--border-soft);
}
[data-theme="dark"] .tiptap table th,
.dark .tiptap table th {
  background-color: var(--panel-soft);
}
.tiptap ul, .markdown-body ul {
  list-style-type: disc;
  padding-left: 1.5rem;
  margin-top: 0.5em;
  margin-bottom: 0.5em;
}
.tiptap ul ul, .markdown-body ul ul {
  list-style-type: circle;
}
.tiptap ul ul ul, .markdown-body ul ul ul {
  list-style-type: square;
}
.tiptap ol, .markdown-body ol {
  list-style-type: decimal;
  padding-left: 1.5rem;
  margin-top: 0.5em;
  margin-bottom: 0.5em;
}
.tiptap ol ol, .markdown-body ol ol {
  list-style-type: lower-alpha;
}
.tiptap ol ol ol, .markdown-body ol ol ol {
  list-style-type: lower-roman;
}
.tiptap li, .markdown-body li {
  display: list-item;
}
.tiptap li::marker, .markdown-body li::marker {
  color: inherit;
}
.tiptap li p, .markdown-body li p {
  margin: 0;
}
.tiptap ul[data-type="taskList"], .markdown-body ul[data-type="taskList"] {
  list-style: none;
  padding: 0;
}
.tiptap ul[data-type="taskList"] p {
  margin: 0;
}
.tiptap ul[data-type="taskList"] li {
  display: flex;
}
.tiptap ul[data-type="taskList"] li > label {
  flex: 0 0 auto;
  margin-right: 0.5rem;
  user-select: none;
  display: flex;
  align-items: center;
}
.tiptap ul[data-type="taskList"] li > label input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}
.tiptap ul[data-type="taskList"] li > div {
  flex: 1 1 auto;
}
</style>
