<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick, markRaw } from 'vue'
import { Editor } from '@tiptap/vue-3'
import {
  List, ListOrdered, CheckSquare, Quote, Code, Minus,
  Bold, Italic, Strikethrough, Highlighter, CodeXml, Palette,
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, Table,
  Pilcrow, ChevronRight
} from 'lucide-vue-next'

const props = defineProps<{
  editor: Editor
}>()

const visible = ref(false)
const position = ref({ top: 0, left: 0 })
const activeSubMenu = ref<string | null>(null)
const subMenuPosition = ref({ top: 0, left: 0 })

const menuRef = ref<HTMLElement | null>(null)
const subMenuRef = ref<HTMLElement | null>(null)

const textStyleIcons = [
  { id: 'bold', label: '加粗', icon: markRaw(Bold), action: () => props.editor.chain().focus().toggleBold().run() },
  { id: 'italic', label: '斜体', icon: markRaw(Italic), action: () => props.editor.chain().focus().toggleItalic().run() },
  { id: 'strike', label: '删除线', icon: markRaw(Strikethrough), action: () => props.editor.chain().focus().toggleStrike().run() },
  { id: 'inlineCode', label: '行内代码', icon: markRaw(CodeXml), action: () => props.editor.chain().focus().toggleCode().run() },
  { id: 'highlight', label: '高亮', icon: markRaw(Highlighter), action: () => props.editor.chain().focus().toggleHighlight().run() },
]

const blockStyleIcons = [
  { id: 'quote', label: '引用', icon: markRaw(Quote), action: () => props.editor.chain().focus().toggleBlockquote().run() },
  { id: 'ul', label: '无序列表', icon: markRaw(List), action: () => props.editor.chain().focus().toggleBulletList().run() },
  { id: 'ol', label: '有序列表', icon: markRaw(ListOrdered), action: () => props.editor.chain().focus().toggleOrderedList().run() },
  { id: 'task', label: '任务框', icon: markRaw(CheckSquare), action: () => props.editor.chain().focus().toggleTaskList().run() },
  { id: 'code', label: '代码块', icon: markRaw(Code), action: () => props.editor.chain().focus().toggleCodeBlock().run() },
  { id: 'table', label: '表格', icon: markRaw(Table), action: () => {
    if (props.editor.can().insertTable) {
      props.editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    }
  }},
]

const listItems = [
  { 
    id: 'paragraph', label: '段落', icon: markRaw(Pilcrow), 
    children: [
      { id: 'p', label: '正文', icon: markRaw(Pilcrow), action: () => props.editor.chain().focus().setParagraph().run() },
      { id: 'h1', label: '一级标题', icon: markRaw(Heading1), action: () => props.editor.chain().focus().toggleHeading({ level: 1 }).run() },
      { id: 'h2', label: '二级标题', icon: markRaw(Heading2), action: () => props.editor.chain().focus().toggleHeading({ level: 2 }).run() },
      { id: 'h3', label: '三级标题', icon: markRaw(Heading3), action: () => props.editor.chain().focus().toggleHeading({ level: 3 }).run() },
      { id: 'h4', label: '四级标题', icon: markRaw(Heading4), action: () => props.editor.chain().focus().toggleHeading({ level: 4 }).run() },
      { id: 'h5', label: '五级标题', icon: markRaw(Heading5), action: () => props.editor.chain().focus().toggleHeading({ level: 5 }).run() },
      { id: 'h6', label: '六级标题', icon: markRaw(Heading6), action: () => props.editor.chain().focus().toggleHeading({ level: 6 }).run() },
    ]
  },
  { id: 'hr', label: '水平分割线', icon: markRaw(Minus), action: () => props.editor.chain().focus().setHorizontalRule().run() },
  { id: 'color', label: '颜色选择器', icon: markRaw(Palette), action: () => {
    const input = document.createElement('input')
    input.type = 'color'
    input.oninput = (e) => {
      const color = (e.target as HTMLInputElement).value
      props.editor.chain().focus().setColor(color).run()
    }
    input.click()
  }}
]

const handleContextMenu = (e: MouseEvent) => {
  if (!props.editor || props.editor.isDestroyed) return
  
  // Check if click is inside editor
  let editorDom
  try {
    editorDom = props.editor.view.dom
  } catch (err) {
    return
  }
  
  if (!editorDom.contains(e.target as Node)) return

  e.preventDefault()
  visible.value = true
  activeSubMenu.value = null

  // Find the scrolling container (.overflow-y-auto)
  let container = editorDom.parentElement
  while (container && !container.classList.contains('overflow-y-auto')) {
    container = container.parentElement
  }

  nextTick(() => {
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

const handleMouseEnter = (item: any, e: MouseEvent) => {
  if (item.children) {
    activeSubMenu.value = item.id
    nextTick(() => {
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

const handleAction = (action?: () => void) => {
  if (!action) return
  action()
  visible.value = false
  activeSubMenu.value = null
  props.editor.commands.focus()
}

const closeMenu = (e: MouseEvent) => {
  if (menuRef.value && !menuRef.value.contains(e.target as Node) &&
      (!subMenuRef.value || !subMenuRef.value.contains(e.target as Node))) {
    visible.value = false
    activeSubMenu.value = null
  }
}

onMounted(() => {
  document.addEventListener('contextmenu', handleContextMenu)
  document.addEventListener('click', closeMenu)
})

onBeforeUnmount(() => {
  document.removeEventListener('contextmenu', handleContextMenu)
  document.removeEventListener('click', closeMenu)
})
</script>

<template>
  <div v-if="visible" class="absolute z-50 pointer-events-none" style="top: 0; left: 0; right: 0; bottom: 0; min-height: 100%;">
    <!-- Main Menu -->
    <div
      ref="menuRef"
      class="absolute w-64 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-xl py-2 pointer-events-auto flex flex-col"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
    >
      <!-- Icon Grids Section -->
      <div class="flex flex-col gap-2 px-3 py-1.5" @mouseenter="activeSubMenu = null">
        <!-- Text Styles -->
        <div class="flex flex-wrap justify-center gap-1.5">
          <button
            v-for="item in textStyleIcons"
            :key="item.id"
            class="flex items-center justify-center w-8 h-8 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 transition-colors"
            :title="item.label"
            @click="handleAction(item.action)"
          >
            <component :is="item.icon" :size="15" />
          </button>
        </div>

        <div class="h-px bg-zinc-100 dark:bg-zinc-800 my-1"></div>

        <!-- Block Styles -->
        <div class="flex flex-wrap justify-center gap-1.5">
          <button
            v-for="item in blockStyleIcons"
            :key="item.id"
            class="flex items-center justify-center w-8 h-8 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 transition-colors"
            :title="item.label"
            @click="handleAction(item.action)"
          >
            <component :is="item.icon" :size="15" />
          </button>
        </div>
      </div>

      <div class="h-px bg-zinc-100 dark:bg-zinc-800 my-1"></div>

      <!-- List Items -->
      <div class="px-1 flex flex-col gap-0.5">
        <div
          v-for="item in listItems"
          :key="item.id"
          class="relative flex items-center justify-between px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer rounded mx-1 transition-colors"
          @click="!item.children && handleAction(item.action)"
          @mouseenter="e => handleMouseEnter(item, e)"
        >
          <div class="flex items-center gap-3">
            <component :is="item.icon" :size="15" class="text-zinc-500" />
            <span>{{ item.label }}</span>
          </div>
          <ChevronRight v-if="item.children" :size="14" class="text-zinc-400" />
        </div>
      </div>
    </div>

    <!-- Sub Menu -->
    <div
      v-if="activeSubMenu"
      ref="subMenuRef"
      class="fixed w-48 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-xl py-1 pointer-events-auto"
      :style="{ top: `${subMenuPosition.top}px`, left: `${subMenuPosition.left}px` }"
    >
      <div
        v-for="subItem in listItems.find(m => m.id === activeSubMenu)?.children"
        :key="subItem.id"
        class="flex items-center gap-3 px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer transition-colors"
        @click="handleAction(subItem.action)"
      >
        <component :is="subItem.icon" :size="16" class="text-zinc-500" />
        <span>{{ subItem.label }}</span>
      </div>
    </div>
  </div>
</template>
