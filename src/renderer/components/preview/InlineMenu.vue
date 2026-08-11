<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { Editor } from '@tiptap/vue-3'
import { Plus } from 'lucide-vue-next'
import { isInTable } from '@tiptap/pm/tables'
import TableSizePicker from './TableSizePicker.vue'
import { useSettingsStore } from '@/renderer/stores/settings'
import {
  insertTableWithSize,
} from '@/shared/utils/tiptap-table-utils'
import {
  getTableMenuActions,
  resolveInlineMenuItems,
} from '@/shared/utils/tiptap-menu-actions'
import type { MenuAction } from '@/shared/types/MenuAction'
import {
  formatEditorShortcut,
  getAdjustedHeadingLevel,
  matchesEditorShortcut,
  type HeadingDirection,
  type HeadingLevel,
} from '@/shared/utils/editor-shortcuts'
import { getOverlayPositionAtLineNumber } from '@/shared/utils/tiptap-line-numbers'

const props = defineProps<{
  editor: Editor
}>()

const emit = defineEmits<{
  (e: 'insert-image'): void
}>()

const settingsStore = useSettingsStore()
const menuVisible = ref(false)
const panelVisible = ref(false)
const buttonPosition = ref({ top: 0, left: 0 })
const panelPosition = ref({ top: 0, left: 0 })
const selectedIndex = ref(0)
const tablePickerVisible = ref(false)
const menuMode = ref<'default' | 'table'>('default')
let isDisposed = false
let blurTimer: ReturnType<typeof setTimeout> | null = null
// 当前被隐藏的行号元素（"+ 按钮断点化"：按钮出现时该行行号消失）
let hiddenLineNumberEl: HTMLElement | null = null

const getEditor = () => {
  if (isDisposed || props.editor.isDestroyed) return null
  return props.editor
}

const defaultMenuItems = computed(() =>
  resolveInlineMenuItems(settingsStore.inlineMenuItems),
)
const tableMenuItems = getTableMenuActions()

const activeMenuItems = computed(() => menuMode.value === 'table' ? tableMenuItems : defaultMenuItems.value)

const getCurrentMenuMode = (editor: Editor) => isInTable(editor.state) ? 'table' : 'default'

const isInNonEmptyCodeBlock = (editor: Editor) => {
  const parent = editor.state.selection.$anchor.parent
  return parent.type.name === 'codeBlock' && parent.textContent.length > 0
}

// 恢复被隐藏的行号；无目标元素时恢复全部
const restoreLineNumbers = (target?: HTMLElement | null) => {
  if (target) {
    target.classList.remove('looma-line-number-hidden')
    return
  }
  document.querySelectorAll('.looma-line-number-hidden').forEach(el =>
    el.classList.remove('looma-line-number-hidden'))
}

const updatePosition = () => {
  const editor = getEditor()
  if (!editor || !editor.isEditable || !editor.isFocused || defaultMenuItems.value.length === 0) {
    restoreLineNumbers(hiddenLineNumberEl)
    hiddenLineNumberEl = null
    menuVisible.value = false
    return
  }

  if (isInNonEmptyCodeBlock(editor)) {
    restoreLineNumbers(hiddenLineNumberEl)
    hiddenLineNumberEl = null
    menuVisible.value = false
    return
  }

  const { view, state } = editor
  const { selection } = state
  const { $anchor } = selection

  // Only show the menu on an empty block (e.g., empty paragraph)
  const isCurrentBlockEmpty = $anchor.parent.textContent.length === 0
  
  if (!isCurrentBlockEmpty) {
    restoreLineNumbers(hiddenLineNumberEl)
    hiddenLineNumberEl = null
    menuVisible.value = false
    return
  }

  // Get the DOM node of the current block
  try {
    // If the selection is at depth 0, we can't go "before" the top-level node.
    const pos = $anchor.depth > 0 ? $anchor.before($anchor.depth) : $anchor.pos;
    const dom = view.nodeDOM(pos) as HTMLElement
    if (dom && dom.getBoundingClientRect) {
      const rect = dom.getBoundingClientRect()
      const editorDom = view.dom
      
      // Find the scrolling container (.overflow-y-auto)
      let container = editorDom.parentElement
      while (container && !container.classList.contains('overflow-y-auto')) {
        container = container.parentElement
      }
      
      if (container) {
        const containerRect = container.getBoundingClientRect()
        const lineNumberEl = dom.querySelector<HTMLElement>('.looma-line-number')
        // 行号在固定宽度的 gutter 列内居中；菜单也以该列为锚点，保证所有行共用同一竖线。
        const lineNumberRect = lineNumberEl?.getBoundingClientRect() || null

        // 行切换时先恢复上一行，再隐藏当前行；按钮完全覆盖行号文本。
        if (lineNumberEl !== hiddenLineNumberEl) {
          restoreLineNumbers(hiddenLineNumberEl)
          hiddenLineNumberEl = lineNumberEl
        }
        lineNumberEl?.classList.add('looma-line-number-hidden')

        if (lineNumberRect) {
          buttonPosition.value = getOverlayPositionAtLineNumber({
            lineNumberRect,
            containerRect,
            scrollTop: container.scrollTop,
            scrollLeft: container.scrollLeft,
            overlaySize: 24,
          })
        } else {
          // 无行号元素（表格单元格/叶子块）：回退到行号栏列中心
          buttonPosition.value = {
            top: rect.top - containerRect.top + container.scrollTop + (rect.height / 2) - 12,
            left: 26 - 12,
          }
        }
      } else {
        const editorRect = editorDom.getBoundingClientRect()
        buttonPosition.value = {
          top: rect.top - editorRect.top + (rect.height / 2) - 12,
          left: -48 // Move it more to the left (was -32)
        }
      }
      menuVisible.value = true
    } else {
      menuVisible.value = false
    }
  } catch (e) {
    restoreLineNumbers(hiddenLineNumberEl)
    hiddenLineNumberEl = null
    menuVisible.value = false
  }
}

const getSelectionPanelPosition = (editor: Editor) => {
  const coords = editor.view.coordsAtPos(editor.state.selection.from)
  let container = editor.view.dom.parentElement
  while (container && !container.classList.contains('overflow-y-auto')) {
    container = container.parentElement
  }

  if (container) {
    const containerRect = container.getBoundingClientRect()
    return {
      top: coords.bottom - containerRect.top + container.scrollTop + 4,
      left: coords.left - containerRect.left + container.scrollLeft,
    }
  }

  const editorRect = editor.view.dom.getBoundingClientRect()
  return {
    top: coords.bottom - editorRect.top + 4,
    left: coords.left - editorRect.left,
  }
}

const keepPanelInViewport = () => {
  setTimeout(() => {
    const panel = document.getElementById('inline-panel')
    if (panel) {
      panel.scrollTop = 0 // Reset scroll when opening
      const rect = panel.getBoundingClientRect()
      if (rect.bottom > window.innerHeight) {
        panelPosition.value.top = Math.max(4, panelPosition.value.top - rect.height - 4)
      }
    }
  }, 0)
}

const openPanel = (mode: 'default' | 'table', anchor: 'button' | 'selection') => {
  const editor = getEditor()
  if (!editor) return

  menuMode.value = mode
  if ((mode === 'default' ? defaultMenuItems.value : tableMenuItems).length === 0) return
  tablePickerVisible.value = false
  selectedIndex.value = 0
  panelVisible.value = true
  panelPosition.value = anchor === 'button'
    ? {
        top: buttonPosition.value.top + 28,
        left: buttonPosition.value.left,
      }
    : getSelectionPanelPosition(editor)
  keepPanelInViewport()
}

const togglePanel = (anchor: 'button' | 'selection' = 'button') => {
  const editor = getEditor()
  if (!editor) return

  if (panelVisible.value) {
    panelVisible.value = false
    tablePickerVisible.value = false
    editor.commands.focus()
    return
  }

  openPanel(getCurrentMenuMode(editor), anchor)
}

const scrollToSelected = () => {
  const panel = document.getElementById('inline-panel')
  if (panel) {
    const selectedElement = panel.children[selectedIndex.value] as HTMLElement
    if (selectedElement) {
      const panelRect = panel.getBoundingClientRect()
      const elementRect = selectedElement.getBoundingClientRect()
      
      if (elementRect.bottom > panelRect.bottom) {
        panel.scrollTop += elementRect.bottom - panelRect.bottom
      } else if (elementRect.top < panelRect.top) {
        panel.scrollTop -= panelRect.top - elementRect.top
      }
    }
  }
}

const getCurrentHeadingLevel = (editor: Editor): HeadingLevel | null => {
  for (let level = 1; level <= 6; level += 1) {
    if (editor.isActive('heading', { level })) return level as HeadingLevel
  }
  return null
}

const adjustCurrentHeading = (editor: Editor, direction: HeadingDirection) => {
  const currentLevel = getCurrentHeadingLevel(editor)
  if (currentLevel === null) return false
  const nextLevel = getAdjustedHeadingLevel(currentLevel, direction)
  if (nextLevel === 'paragraph') return editor.chain().focus().setParagraph().run()
  return editor.chain().focus().setHeading({ level: nextLevel }).run()
}

const runInlineMenuShortcut = (editor: Editor, index: number) => {
  const item = defaultMenuItems.value[index]
  if (!item) return false

  if (item.kind === 'tablePicker') {
    openPanel('default', 'selection')
    tablePickerVisible.value = true
    return true
  }
  if (item.kind === 'image') {
    panelVisible.value = false
    tablePickerVisible.value = false
    emit('insert-image')
    return true
  }

  item.run(editor)
  panelVisible.value = false
  tablePickerVisible.value = false
  editor.commands.focus()
  return true
}

const handleConfiguredShortcut = (event: KeyboardEvent, editor: Editor) => {
  const shortcuts = settingsStore.editorShortcuts
  if (matchesEditorShortcut(event, shortcuts.headingLevelUp)
    && adjustCurrentHeading(editor, 'up')) return true
  if (matchesEditorShortcut(event, shortcuts.headingLevelDown)
    && adjustCurrentHeading(editor, 'down')) return true

  const slotIndex = shortcuts.inlineMenuSlots.findIndex(shortcut => matchesEditorShortcut(event, shortcut))
  return slotIndex >= 0 && runInlineMenuShortcut(editor, slotIndex)
}

const handleKeyDown = (event: KeyboardEvent) => {
  const editor = getEditor()
  if (!editor) return false

  if (handleConfiguredShortcut(event, editor)) {
    event.preventDefault()
    event.stopImmediatePropagation()
    return true
  }

  if (event.key === 'Enter' && event.shiftKey && event.ctrlKey) {
    event.preventDefault()
    event.stopImmediatePropagation()
    const mode = getCurrentMenuMode(editor)
    if (mode === 'table' || defaultMenuItems.value.length > 0) {
      togglePanel('selection')
    }
    return true
  }

  if (panelVisible.value) {
    const items = activeMenuItems.value
    if (items.length === 0) return false
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopImmediatePropagation()
      selectedIndex.value = (selectedIndex.value - 1 + items.length) % items.length
      scrollToSelected()
      return true
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopImmediatePropagation()
      selectedIndex.value = (selectedIndex.value + 1) % items.length
      scrollToSelected()
      return true
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopImmediatePropagation()
      handleFormatAction(items[selectedIndex.value])
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      panelVisible.value = false
      tablePickerVisible.value = false
      editor.commands.focus()
      return true
    }
  }
  return false
}

const handleGlobalClick = (event: MouseEvent) => {
  if (isDisposed) return
  if (panelVisible.value) {
    const target = event.target as HTMLElement
    const button = document.getElementById('inline-menu-button')
    const panel = document.getElementById('inline-panel')
    
    if (button && button.contains(target)) return
    if (panel && panel.contains(target)) return
    
    panelVisible.value = false
    tablePickerVisible.value = false
  }
}

const handleFormatAction = (item: MenuAction) => {
  const editor = getEditor()
  if (!editor) return

  if (item.kind === 'tablePicker') {
    tablePickerVisible.value = !tablePickerVisible.value
    return
  }

  if (item.kind === 'image') {
    panelVisible.value = false
    tablePickerVisible.value = false
    emit('insert-image')
    return
  }

  item.run(editor)
  panelVisible.value = false
  tablePickerVisible.value = false
  editor.commands.focus()
}

const handleTableSizeSelect = (size: { rows: number; cols: number }) => {
  const editor = getEditor()
  if (!editor) return

  insertTableWithSize(editor, size.rows, size.cols)
  panelVisible.value = false
  tablePickerVisible.value = false
  editor.commands.focus()
}

onMounted(() => {
  props.editor.on('selectionUpdate', updatePosition)
  props.editor.on('update', updatePosition)
  props.editor.on('focus', updatePosition)
  props.editor.on('blur', () => {
    // Hide menu after a short delay to allow clicking the button
    blurTimer = setTimeout(() => {
      if (isDisposed) return
      if (!panelVisible.value) {
        menuVisible.value = false
        restoreLineNumbers(hiddenLineNumberEl)
        hiddenLineNumberEl = null
      }
    }, 200)
  })

  // Register keydown handler in TipTap
  props.editor.view.dom.addEventListener('keydown', handleKeyDown, { capture: true })
  
  // Close menu when clicking outside
  document.addEventListener('mousedown', handleGlobalClick)
})

onBeforeUnmount(() => {
  isDisposed = true
  restoreLineNumbers(hiddenLineNumberEl)
  hiddenLineNumberEl = null
  if (blurTimer) {
    clearTimeout(blurTimer)
    blurTimer = null
  }
  document.removeEventListener('mousedown', handleGlobalClick)
  
  if (props.editor && !props.editor.isDestroyed) {
    props.editor.off('selectionUpdate', updatePosition)
    props.editor.off('update', updatePosition)
    props.editor.off('focus', updatePosition)
    
    try {
      props.editor.view?.dom?.removeEventListener('keydown', handleKeyDown, { capture: true })
    } catch (e) {
      // Ignore if view is already not available
    }
  }
})
</script>

<template>
  <div>
    <!-- "+" Button -->
    <button
      v-if="menuVisible"
      id="inline-menu-button"
      class="absolute flex items-center justify-center w-6 h-6 rounded-full bg-panel-soft hover:bg-accent-soft text-text-muted transition-colors z-10"
      :style="{ top: `${buttonPosition.top}px`, left: `${buttonPosition.left}px` }"
      @click="togglePanel()"
    >
      <Plus :size="14" />
    </button>

    <!-- Floating Panel -->
    <div
      v-if="panelVisible"
      id="inline-panel"
      class="absolute w-56 bg-panel border border-border-soft rounded-lg shadow-xl z-20 py-1 overflow-y-auto max-h-[220px]"
      :style="{ top: `${panelPosition.top}px`, left: `${panelPosition.left}px` }"
    >
      <div
        v-for="(item, index) in activeMenuItems"
        :key="item.id"
        class="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors"
        :class="{
          'bg-accent-soft text-accent': index === selectedIndex,
          'text-text-main hover:bg-accent-soft/50': index !== selectedIndex
        }"
        @click="handleFormatAction(item)"
        @mouseenter="selectedIndex = index"
      >
        <component :is="item.icon" :size="16" />
        <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
        <span
          v-if="menuMode === 'default' && index < 9 && settingsStore.editorShortcuts.inlineMenuSlots[index]?.enabled"
          class="shrink-0 rounded border border-border-soft bg-panel-soft px-1.5 py-0.5 text-[9px] text-text-muted"
        >
          {{ formatEditorShortcut(settingsStore.editorShortcuts.inlineMenuSlots[index]) }}
        </span>
      </div>

      <div v-if="menuMode === 'default' && tablePickerVisible" class="px-3 py-2">
        <TableSizePicker @select="handleTableSizeSelect" />
      </div>
    </div>
  </div>
</template>
