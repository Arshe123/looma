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

const props = defineProps<{
  editor: Editor
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

const updatePosition = () => {
  const editor = getEditor()
  if (!editor || !editor.isEditable || !editor.isFocused || defaultMenuItems.value.length === 0) {
    menuVisible.value = false
    return
  }

  if (isInNonEmptyCodeBlock(editor)) {
    menuVisible.value = false
    return
  }

  const { view, state } = editor
  const { selection } = state
  const { $anchor } = selection

  // Only show the menu on an empty block (e.g., empty paragraph)
  const isCurrentBlockEmpty = $anchor.parent.textContent.length === 0
  
  if (!isCurrentBlockEmpty) {
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
        // Position the "+" button relative to the scrolling container
        buttonPosition.value = {
          top: rect.top - containerRect.top + container.scrollTop + (rect.height / 2) - 12,
          left: 4 // Move it more to the left (was 16)
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

const handleKeyDown = (event: KeyboardEvent) => {
  const editor = getEditor()
  if (!editor) return false

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
      class="absolute w-48 bg-panel border border-border-soft rounded-lg shadow-xl z-20 py-1 overflow-y-auto max-h-[220px]"
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
        <span>{{ item.label }}</span>
      </div>

      <div v-if="menuMode === 'default' && tablePickerVisible" class="px-3 py-2">
        <TableSizePicker @select="handleTableSizeSelect" />
      </div>
    </div>
  </div>
</template>
