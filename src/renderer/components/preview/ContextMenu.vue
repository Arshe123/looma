<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { Editor } from '@tiptap/vue-3'
import { ChevronRight, Pilcrow } from 'lucide-vue-next'
import { isInTable } from '@tiptap/pm/tables'
import TableSizePicker from './TableSizePicker.vue'
import {
  insertTableWithSize,
} from '@/shared/utils/tiptap-table-utils'
import {
  getTableMenuActions,
  getMenuAction,
  resolveMenuActions,
} from '@/shared/utils/tiptap-menu-actions'
import type { MenuAction } from '@/shared/types/MenuAction'

const props = defineProps<{
  editor: Editor
}>()

type ContextMenuItem = {
  id: string
  label: string
  icon: MenuAction['icon']
  children?: MenuAction[]
}

const visible = ref(false)
const position = ref({ top: 0, left: 0 })
const activeSubMenu = ref<string | null>(null)
const subMenuPosition = ref({ top: 0, left: 0 })
const menuMode = ref<'default' | 'table'>('default')
const tablePickerVisible = ref(false)

const menuRef = ref<HTMLElement | null>(null)
const subMenuRef = ref<HTMLElement | null>(null)
let isDisposed = false

const getEditor = () => {
  if (isDisposed || props.editor.isDestroyed) return null
  return props.editor
}

const textStyleIcons = resolveMenuActions(['bold', 'italic', 'strike', 'inlineCode', 'highlight'])

const blockStyleIcons = resolveMenuActions(['blockquote', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'table'])

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
  const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
  if (pos) {
    editor.chain().focus().setTextSelection(pos.pos).run()
  } else {
    editor.commands.focus()
  }

  visible.value = true
  activeSubMenu.value = null
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

const handleMouseEnter = (item: ContextMenuItem, e: MouseEvent) => {
  if (!getEditor()) return
  if (item.children) {
    activeSubMenu.value = item.id
    nextTick(() => {
      if (isDisposed || !getEditor()) return
      if (menuRef.value && subMenuRef.value) {
        const target = e.currentTarget as HTMLElement
        const menuRect = menuRef.value.getBoundingClientRect()
        const subRect = subMenuRef.value.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        
        // 默认将子菜单放在主菜单右侧，与当前项水平对齐
        let top = targetRect.top
        let left = menuRect.right

        // 如果右侧空间不够，则放在主菜单左侧
        if (left + subRect.width > window.innerWidth) {
          left = menuRect.left - subRect.width
        }
        
        // 如果底部空间不够，则向上偏移
        if (top + subRect.height > window.innerHeight) {
          top = window.innerHeight - subRect.height - 10
        }
        
        subMenuPosition.value = { top, left }
      }
    })
  } else {
    activeSubMenu.value = null
  }
}

const handleAction = (item?: MenuAction) => {
  const editor = getEditor()
  if (!editor) return

  if (!item) return
  if (item.kind === 'tablePicker') {
    tablePickerVisible.value = !tablePickerVisible.value
    activeSubMenu.value = null
    return
  }
  item.run(editor)
  visible.value = false
  activeSubMenu.value = null
  tablePickerVisible.value = false
  editor.commands.focus()
}

const handleListItemClick = (item: ContextMenuItem) => {
  if (item.children) return
  const action = getMenuAction(item.id)
  if (action) handleAction(action)
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
  if (menuRef.value && !menuRef.value.contains(e.target as Node) &&
      (!subMenuRef.value || !subMenuRef.value.contains(e.target as Node))) {
    visible.value = false
    activeSubMenu.value = null
    tablePickerVisible.value = false
  }
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
  <div v-if="visible" class="absolute z-50 pointer-events-none" style="top: 0; left: 0; right: 0; bottom: 0; min-height: 100%;">
    <!-- Main Menu -->
    <div
      ref="menuRef"
      class="absolute w-64 bg-panel border border-border-soft rounded-lg shadow-xl py-2 pointer-events-auto flex flex-col"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
    >
      <div v-if="menuMode === 'default'" key="default-menu" class="flex flex-col">
      <!-- Icon Grids Section -->
      <div class="flex flex-col gap-2 px-3 py-1.5" @mouseenter="activeSubMenu = null">
        <!-- Text Styles -->
        <div class="flex flex-wrap justify-center gap-1.5">
          <button
            v-for="item in textStyleIcons"
            :key="item.id"
            class="flex items-center justify-center w-8 h-8 rounded bg-panel border border-border-soft hover:bg-accent-soft text-text-main transition-colors"
            :title="item.label"
            @click="handleAction(item)"
          >
            <component :is="item.icon" :key="`${item.id}-icon`" :size="15" />
          </button>
        </div>

        <div class="h-px bg-accent-soft my-1"></div>

        <!-- Block Styles -->
        <div class="flex flex-wrap justify-center gap-1.5">
          <button
            v-for="item in blockStyleIcons"
            :key="item.id"
            class="flex items-center justify-center w-8 h-8 rounded bg-panel border border-border-soft hover:bg-accent-soft text-text-main transition-colors"
            :title="item.label"
            @click="handleAction(item)"
          >
            <component :is="item.icon" :key="`${item.id}-icon`" :size="15" />
          </button>
        </div>

        <div v-if="tablePickerVisible" class="flex justify-center pt-1">
          <TableSizePicker @select="handleTableSizeSelect" />
        </div>
      </div>

      <div class="h-px bg-accent-soft my-1"></div>

      <!-- List Items -->
      <div class="px-1 flex flex-col gap-0.5">
        <div
          v-for="item in listItems"
          :key="item.id"
          class="relative flex items-center justify-between px-3 py-1.5 text-sm text-text-main hover:bg-accent-soft cursor-pointer rounded mx-1 transition-colors"
          @click="handleListItemClick(item)"
          @mouseenter="e => handleMouseEnter(item, e)"
        >
          <div class="flex items-center gap-3">
            <component :is="item.icon" :key="`${item.id}-icon`" :size="15" class="text-text-muted" />
            <span>{{ item.label }}</span>
          </div>
          <ChevronRight v-if="item.children" :size="14" class="text-text-subtle" />
        </div>
      </div>
      </div>

      <div v-else key="table-menu" class="px-1 py-1 flex flex-col gap-0.5">
        <button
          v-for="item in tableMenuItems"
          :key="item.id"
          type="button"
          class="flex items-center gap-3 px-3 py-1.5 text-sm text-text-main hover:bg-accent-soft cursor-pointer rounded mx-1 transition-colors text-left"
          @click="handleAction(item)"
        >
          <component :is="item.icon" :key="`${item.id}-icon`" :size="15" class="text-text-muted" />
          <span>{{ item.label }}</span>
        </button>
      </div>
    </div>

    <!-- Sub Menu -->
    <div
      v-if="activeSubMenu"
      ref="subMenuRef"
      class="fixed w-48 bg-panel border border-border-soft rounded-lg shadow-xl py-1 pointer-events-auto"
      :style="{ top: `${subMenuPosition.top}px`, left: `${subMenuPosition.left}px` }"
    >
      <div
        v-for="subItem in listItems.find(m => m.id === activeSubMenu)?.children"
        :key="subItem.id"
        class="flex items-center gap-3 px-4 py-2 text-sm text-text-main hover:bg-accent-soft cursor-pointer transition-colors"
        @click="handleAction(subItem)"
      >
        <component :is="subItem.icon" :key="`${subItem.id}-icon`" :size="16" class="text-text-muted" />
        <span>{{ subItem.label }}</span>
      </div>
    </div>
  </div>
</template>
