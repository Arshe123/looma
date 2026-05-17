<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Editor } from '@tiptap/vue-3'
import {
  Copy,
  TableProperties,
  Trash2,
} from 'lucide-vue-next'
import { findTable, isInTable, TableMap } from '@tiptap/pm/tables'
import TableSizePicker from './TableSizePicker.vue'
import {
  copyCurrentTable,
  resizeCurrentTable,
} from '@/common/util/tiptap-table-utils'

const props = defineProps<{
  editor: Editor
}>()

const visible = ref(false)
const sizePickerVisible = ref(false)
const currentTableSize = ref({ rows: 3, cols: 3 })
const toolbarRef = ref<HTMLElement | null>(null)
const position = ref({ top: 0, left: 0 })
const isHoveringTable = ref(false)
const activeTableElement = ref<HTMLElement | null>(null)
let isDisposed = false

const getEditor = () => {
  if (isDisposed || props.editor.isDestroyed) return null
  return props.editor
}

const getScrollContainer = () => {
  const editor = getEditor()
  if (!editor) return null

  let container = editor.view.dom.parentElement
  while (container && !container.classList.contains('overflow-y-auto')) {
    container = container.parentElement
  }
  return container
}

const getTableElement = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return null
  const wrapper = target.closest('.tableWrapper')
  if (wrapper instanceof HTMLElement) return wrapper
  const table = target.closest('table')
  if (table instanceof HTMLElement) return (table.closest('.tableWrapper') as HTMLElement | null) ?? table
  return null
}

const getSelectionTableElement = () => {
  const editor = getEditor()
  if (!editor) return null
  if (!isInTable(editor.state)) return null
  const table = findTable(editor.state.selection.$from)
  if (!table) return null
  const dom = editor.view.nodeDOM(table.pos)
  if (!(dom instanceof HTMLElement)) return null
  return dom.classList.contains('tableWrapper') ? dom : ((dom.closest('.tableWrapper') as HTMLElement | null) ?? dom)
}

const updatePosition = (tableElement = activeTableElement.value) => {
  if (!tableElement) return
  const container = getScrollContainer()
  if (!container) return

  const tableRect = tableElement.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()

  activeTableElement.value = tableElement
  position.value = {
    top: tableRect.top - containerRect.top + container.scrollTop - 36,
    left: tableRect.left - containerRect.left + container.scrollLeft,
  }
}

const showForTable = (tableElement: HTMLElement) => {
  if (!getEditor()) return
  visible.value = true
  activeTableElement.value = tableElement
  nextTick(() => {
    if (isDisposed || !getEditor()) return
    updatePosition(tableElement)
  })
}

const shouldStayVisible = () => {
  const editor = getEditor()
  return sizePickerVisible.value || isHoveringTable.value || Boolean(editor && isInTable(editor.state))
}

const hideIfIdle = () => {
  if (shouldStayVisible()) return
  visible.value = false
  activeTableElement.value = null
}

const handleMouseMove = (event: MouseEvent) => {
  if (!getEditor()) return
  const tableElement = getTableElement(event.target)

  if (tableElement) {
    isHoveringTable.value = true
    showForTable(tableElement)
    return
  }

  if (toolbarRef.value?.contains(event.target as Node)) return

  isHoveringTable.value = false
  hideIfIdle()
}

const handleSelectionUpdate = () => {
  if (!getEditor()) return
  const tableElement = getSelectionTableElement()
  if (tableElement) {
    showForTable(tableElement)
    return
  }

  hideIfIdle()
}

const runAction = (action: () => boolean) => {
  const editor = getEditor()
  if (!editor) return

  focusActiveTable()
  action()
  sizePickerVisible.value = false
  editor.commands.focus()
  handleSelectionUpdate()
}

const focusActiveTable = () => {
  if (!activeTableElement.value) return
  const editor = getEditor()
  if (!editor) return

  try {
    const pos = editor.view.posAtDOM(activeTableElement.value, 0)
    const targetPos = Math.min(pos + 2, editor.state.doc.content.size)
    editor.chain().focus().setTextSelection(targetPos).run()
  } catch (e) {
    editor.commands.focus()
  }
}

const handleResize = (size: { rows: number; cols: number }) => {
  runAction(() => resizeCurrentTable(props.editor, size.rows, size.cols))
}

const updateCurrentTableSize = () => {
  const editor = getEditor()
  if (!editor) return
  if (!isInTable(editor.state)) return

  const table = findTable(editor.state.selection.$from)
  if (!table) return

  const map = TableMap.get(table.node)
  currentTableSize.value = {
    rows: table.node.childCount,
    cols: map.width,
  }
}

const toggleSizePicker = () => {
  const shouldShow = !sizePickerVisible.value
  sizePickerVisible.value = shouldShow
  if (!shouldShow) return

  focusActiveTable()
  updateCurrentTableSize()
}

onMounted(() => {
  props.editor.view.dom.addEventListener('mousemove', handleMouseMove)
  props.editor.on('selectionUpdate', handleSelectionUpdate)
  props.editor.on('transaction', handleSelectionUpdate)
  window.addEventListener('resize', handleSelectionUpdate)
})

onBeforeUnmount(() => {
  isDisposed = true
  try {
    if (!props.editor.isDestroyed) {
      props.editor.view.dom.removeEventListener('mousemove', handleMouseMove)
      props.editor.off('selectionUpdate', handleSelectionUpdate)
      props.editor.off('transaction', handleSelectionUpdate)
    }
  } catch (e) {
    // Editor teardown may already be in progress.
  }
  window.removeEventListener('resize', handleSelectionUpdate)
})
</script>

<template>
  <div
    v-if="visible"
    ref="toolbarRef"
    class="table-toolbar"
    :style="{ top: `${position.top}px`, left: `${position.left}px` }"
    @mouseenter="isHoveringTable = true"
    @mouseleave="isHoveringTable = false; hideIfIdle()"
  >
    <button type="button" title="调整表格大小" @click="toggleSizePicker">
      <TableProperties :size="15" />
    </button>
    <button type="button" title="复制表格" @click="runAction(() => copyCurrentTable(editor))">
      <Copy :size="15" />
    </button>
    <button type="button" title="删除表格" @click="runAction(() => editor.chain().focus().deleteTable().run())">
      <Trash2 :size="15" />
    </button>

    <div v-if="sizePickerVisible" class="table-toolbar__picker">
      <TableSizePicker
        mode="resize"
        :current-rows="currentTableSize.rows"
        :current-cols="currentTableSize.cols"
        @select="handleResize"
      />
    </div>
  </div>
</template>

<style scoped>
.table-toolbar {
  position: absolute;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.25rem;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 14px 36px rgb(0 0 0 / 14%);
}

.table-toolbar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.8rem;
  height: 1.8rem;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  transition: color 100ms ease, background 100ms ease, border-color 100ms ease;
}

.table-toolbar button:hover {
  border-color: var(--border-soft);
  color: var(--text-main);
  background: var(--accent-soft);
}

.table-toolbar__picker {
  position: absolute;
  top: calc(100% + 0.35rem);
  left: 0;
}
</style>
