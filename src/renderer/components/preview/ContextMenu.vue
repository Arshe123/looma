<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { Editor } from '@tiptap/vue-3'
import { Pilcrow } from 'lucide-vue-next'
import { isInTable } from '@tiptap/pm/tables'
import ContextMenuPresentation from './menus/ContextMenuPresentation.vue'
import { contextClipboardItems } from './menus/menuPresentation'
import {
  insertTableWithSize,
} from '@/shared/utils/tiptap-table-utils'
import {
  getTableMenuActions,
  getMenuAction,
  resolveMenuActions,
} from '@/shared/utils/tiptap-menu-actions'
import { formatMarkdownLink, selectionHasMarkdownSource } from '@/shared/utils/tiptap-clipboard'
import { parseNoteLinkHref } from '@/shared/utils/note-link-ref'
import type { MenuAction } from '@/shared/types/MenuAction'
import { isMacPlatform } from '@/shared/utils/window-chrome'
import { getInlineMarkdownLinkAtPosition } from '@/shared/utils/tiptap-inline-markdown'

const props = defineProps<{
  editor: Editor
  relativeFilePath: string
}>()

const emit = defineEmits<{
  (e: 'insert-image'): void
  (e: 'copy', text?: string): void
  (e: 'copy-source', text?: string): void
  (e: 'paste'): void
}>()

type ContextMenuItem = {
  id: string
  label: string
  icon: MenuAction['icon']
  children?: MenuAction[]
}

const visible = ref(false)
const position = ref({ top: 0, left: 0 })
const menuMode = ref<'default' | 'table'>('default')
const tablePickerVisible = ref(false)
const quickCopyText = ref<string | null>(null)
const sourceCopyAvailable = ref(false)
const isMac = isMacPlatform(window.electronAPI.platform)

const menuRef = ref<HTMLElement | null>(null)
let isDisposed = false

const getEditor = () => {
  if (isDisposed || props.editor.isDestroyed) return null
  return props.editor
}

const textStyleIcons = resolveMenuActions(['bold', 'italic', 'strike', 'inlineCode', 'highlight'])

const blockStyleIcons = resolveMenuActions(['blockquote', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'image', 'table'])

const tableMenuItems = getTableMenuActions()

const horizontalRuleAction = getMenuAction('horizontalRule')

const listItems: ContextMenuItem[] = [
  { 
    id: 'paragraph',
    label: '段落',
    icon: getMenuAction('paragraph')?.icon ?? Pilcrow,
    children: resolveMenuActions(['paragraph', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']),
  },
  ...(horizontalRuleAction ? [horizontalRuleAction] : []),
]

const selectContextTarget = (editor: Editor, event: MouseEvent) => {
  const targetPosition = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!targetPosition) {
    editor.commands.focus()
    return
  }

  const imageTarget = (event.target as HTMLElement | null)?.closest?.('.local-image-node')
  if (imageTarget) {
    const candidates = [targetPosition.inside, targetPosition.pos, targetPosition.pos - 1, targetPosition.pos + 1]
    const imagePosition = candidates.find((candidate) => (
      candidate >= 0 && editor.state.doc.nodeAt(candidate)?.type.name === 'image'
    ))
    if (imagePosition !== undefined) {
      editor.chain().focus().setNodeSelection(imagePosition).run()
      return
    }
  }

  const { from, to, empty } = editor.state.selection
  if (!empty && targetPosition.pos >= from && targetPosition.pos <= to) {
    editor.commands.focus()
    return
  }
  editor.chain().focus().setTextSelection(targetPosition.pos).run()
}

const handleContextMenu = (e: MouseEvent) => {
  const editor = getEditor()
  if (!editor) return
  
  // Check if click is inside editor
  let editorDom
  try {
    editorDom = editor.view.dom
  } catch (err) {
    return
  }
  
  if (!editorDom.contains(e.target as Node)) return

  e.preventDefault()
  const anchorTarget = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  const href = anchorTarget?.getAttribute('href') || ''
  const sourcePosition = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos
  const sourceLink = sourcePosition !== undefined ? getInlineMarkdownLinkAtPosition(editor.state, sourcePosition) : null
  quickCopyText.value = sourceLink && parseNoteLinkHref(sourceLink.href, props.relativeFilePath)
    ? sourceLink.source
    : anchorTarget && parseNoteLinkHref(href, props.relativeFilePath)
      ? formatMarkdownLink((anchorTarget.textContent || '').trim(), href)
      : null
  selectContextTarget(editor, e)
  sourceCopyAvailable.value = Boolean(quickCopyText.value) || selectionHasMarkdownSource(editor.state)

  visible.value = true
  tablePickerVisible.value = false
  menuMode.value = isInTable(editor.state) ? 'table' : 'default'

  // Find the scrolling container (.overflow-y-auto)
  let container = editorDom.parentElement
  while (container && !container.classList.contains('overflow-y-auto')) {
    container = container.parentElement
  }

  nextTick(() => {
    if (isDisposed || !getEditor()) return
    let top = e.clientY
    let left = e.clientX

    if (container) {
      const containerRect = container.getBoundingClientRect()
      top = e.clientY - containerRect.top + container.scrollTop
      left = e.clientX - containerRect.left + container.scrollLeft
    }

    if (menuRef.value && container) {
      const rect = menuRef.value.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      if (e.clientY + rect.height > containerRect.bottom) {
        top -= rect.height
      }
      if (e.clientX + rect.width > containerRect.right) {
        left -= rect.width
      }
    }

    position.value = { top, left }
  })
}

const handleAction = (item?: MenuAction) => {
  const editor = getEditor()
  if (!editor) return

  if (!item) return
  if (item.kind === 'tablePicker') {
    tablePickerVisible.value = !tablePickerVisible.value
      return
  }
  if (item.kind === 'image') {
    visible.value = false
      tablePickerVisible.value = false
    emit('insert-image')
    return
  }
  item.run(editor)
  visible.value = false
  tablePickerVisible.value = false
  editor.commands.focus()
}

const handleClipboardAction = (action: 'copy' | 'copy-source' | 'paste') => {
  if (!getEditor()) return
  const copyText = quickCopyText.value || undefined
  visible.value = false
  tablePickerVisible.value = false
  quickCopyText.value = null
  sourceCopyAvailable.value = false
  if (action === 'copy') emit('copy', copyText)
  else if (action === 'copy-source') emit('copy-source', copyText)
  else emit('paste')
}

const handleTableSizeSelect = (size: { rows: number; cols: number }) => {
  const editor = getEditor()
  if (!editor) return

  insertTableWithSize(editor, size.rows, size.cols)
  visible.value = false
  tablePickerVisible.value = false
  editor.commands.focus()
}

const closeMenu = (e: MouseEvent) => {
  if (isDisposed) return
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    visible.value = false
      tablePickerVisible.value = false
    quickCopyText.value = null
    sourceCopyAvailable.value = false
  }
}

const clipboardItems = computed(() => contextClipboardItems({ isMac, reference: !!quickCopyText.value, sourceCopy: sourceCopyAvailable.value }))
const handlePresentationAction = (id: string) => {
  if (id === 'copy' || id === 'copy-source' || id === 'paste') handleClipboardAction(id)
  else handleAction(tableMenuItems.find(item => item.id === id) ?? getMenuAction(id))
}

onMounted(() => {
  document.addEventListener('contextmenu', handleContextMenu)
  document.addEventListener('click', closeMenu)
})

onBeforeUnmount(() => {
  isDisposed = true
  document.removeEventListener('contextmenu', handleContextMenu)
  document.removeEventListener('click', closeMenu)
})
</script>

<template>
  <div v-if="visible" data-looma-editor-context-menu class="absolute z-50 pointer-events-none" style="inset: 0; min-height: 100%;">
    <div ref="menuRef" class="absolute pointer-events-auto" :style="{ top: `${position.top}px`, left: `${position.left}px` }">
      <ContextMenuPresentation
        :mode="menuMode" :text-style-icons="textStyleIcons" :block-style-icons="blockStyleIcons"
        :list-items="listItems" :table-items="tableMenuItems" :clipboard-items="clipboardItems"
        :table-picker-visible="tablePickerVisible" @action="handlePresentationAction" @table-size="handleTableSizeSelect"
      />
    </div>
  </div>
</template>
