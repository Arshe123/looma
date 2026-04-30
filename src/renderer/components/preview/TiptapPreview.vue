<script setup lang="ts">
import { shallowRef, watch, onMounted, onBeforeUnmount, nextTick, ref } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import type { Editor as CoreEditor } from '@tiptap/core'
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

const props = defineProps<{
  content: string
}>()

const emit = defineEmits<{
  (e: 'update:content', value: string): void
}>()

let isUpdatingFromExternal = false
let lastEmittedContent = ''

const editor = shallowRef<Editor | null>(null)
const previewContainer = ref<HTMLElement | null>(null)
const CURSOR_BOTTOM_THRESHOLD_PX = 120

const ensureCursorComfort = (instance: CoreEditor) => {
  if (!instance.isFocused) return
  if (!previewContainer.value) return

  const containerRect = previewContainer.value.getBoundingClientRect()
  const pos = instance.state.selection.$head.pos

  let cursorRect: { top: number; bottom: number; left: number; right: number } | null = null
  try {
    cursorRect = instance.view.coordsAtPos(pos)
  } catch (e) {
    if (pos > 0) {
      try {
        cursorRect = instance.view.coordsAtPos(pos - 1)
      } catch {
        cursorRect = null
      }
    }
  }
  if (!cursorRect) return

  const distanceToBottom = containerRect.bottom - cursorRect.bottom
  if (distanceToBottom < CURSOR_BOTTOM_THRESHOLD_PX) {
    const delta = CURSOR_BOTTOM_THRESHOLD_PX - distanceToBottom
    previewContainer.value.scrollTop += Math.ceil(delta)
  }
}

onMounted(() => {
  editor.value = new Editor({
    extensions: [
      StarterKit.configure({
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
        placeholder: '输入 / 唤起菜单，或直接输入 Markdown...',
      }),
      Markdown.configure({
        html: true,
        transformPastedText: true,
      }),
    ],
    content: props.content,
    editorProps: {
      attributes: {
        class: 'prose dark:prose-invert max-w-none focus:outline-none min-h-full p-8 markdown-body dark:markdown-body-dark',
      },
    },
    onUpdate: ({ editor }) => {
      ensureCursorComfort(editor)
      if (isUpdatingFromExternal) return
      const markdown = (editor.storage as any).markdown.getMarkdown()
      lastEmittedContent = markdown
      emit('update:content', markdown)
    },
    onSelectionUpdate: ({ editor }) => {
      ensureCursorComfort(editor)
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
    editor.value.commands.setContent(newContent, { emitUpdate: false })
    
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
  <div ref="previewContainer" class="h-full w-full bg-white dark:bg-zinc-900 overflow-y-auto relative tiptap-preview-container tiptap-editor-wrapper">
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
  color: #1b1b1b;
  padding-bottom: calc(2rem + 22vh) !important;
}

.dark .markdown-body {
  color: #d4d4d4;
  background-color: transparent !important;
}

.markdown-body p {
  margin-bottom: 0.6em;
}

.markdown-body-dark {
  background-color: transparent !important;
}
.tiptap p.is-editor-empty:first-child::before {
  color: #adb5bd;
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
  border: 1px solid #ced4da;
  padding: 3px 5px;
  vertical-align: top;
  box-sizing: border-box;
  position: relative;
}
.tiptap table th {
  font-weight: bold;
  text-align: left;
  background-color: #f1f3f5;
}
.dark .tiptap table td,
.dark .tiptap table th {
  border-color: #3f3f46;
}
.dark .tiptap table th {
  background-color: #27272a;
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
