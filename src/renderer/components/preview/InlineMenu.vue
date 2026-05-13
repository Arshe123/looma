<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, markRaw } from 'vue'
import { Editor } from '@tiptap/vue-3'
import { Plus, List, ListOrdered, CheckSquare, Quote, Code, Minus, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6 } from 'lucide-vue-next'

const props = defineProps<{
  editor: Editor
}>()

const menuVisible = ref(false)
const panelVisible = ref(false)
const buttonPosition = ref({ top: 0, left: 0 })
const panelPosition = ref({ top: 0, left: 0 })
const selectedIndex = ref(0)

const formats = [
    { id: 'h2', label: '二级标题', icon: markRaw(Heading2), action: () => props.editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { id: 'h3', label: '三级标题', icon: markRaw(Heading3), action: () => props.editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { id: 'h4', label: '四级标题', icon: markRaw(Heading4), action: () => props.editor.chain().focus().toggleHeading({ level: 4 }).run() },
    { id: 'h5', label: '五级标题', icon: markRaw(Heading5), action: () => props.editor.chain().focus().toggleHeading({ level: 5 }).run() },
    { id: 'h6', label: '六级标题', icon: markRaw(Heading6), action: () => props.editor.chain().focus().toggleHeading({ level: 6 }).run() },
    { id: 'bulletList', label: '无序列表', icon: markRaw(List), action: () => props.editor.chain().focus().toggleBulletList().run() },
    { id: 'orderedList', label: '有序列表', icon: markRaw(ListOrdered), action: () => props.editor.chain().focus().toggleOrderedList().run() },
    { id: 'taskList', label: '任务框', icon: markRaw(CheckSquare), action: () => props.editor.chain().focus().toggleTaskList().run() },
    { id: 'blockquote', label: '引用', icon: markRaw(Quote), action: () => props.editor.chain().focus().toggleBlockquote().run() },
    { id: 'codeBlock', label: '代码块', icon: markRaw(Code), action: () => props.editor.chain().focus().toggleCodeBlock().run() },
    { id: 'horizontalRule', label: '水平分割线', icon: markRaw(Minus), action: () => props.editor.chain().focus().setHorizontalRule().run() },
]

const updatePosition = () => {
  if (!props.editor || !props.editor.isEditable || !props.editor.isFocused) {
    menuVisible.value = false
    return
  }

  const { view, state } = props.editor
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

const togglePanel = () => {
  panelVisible.value = !panelVisible.value
  if (panelVisible.value) {
    selectedIndex.value = 0
    const editorRect = props.editor.view.dom.getBoundingClientRect()
    panelPosition.value = {
      top: buttonPosition.value.top + 28,
      left: buttonPosition.value.left
    }
    // Simple overflow check
    setTimeout(() => {
      const panel = document.getElementById('inline-panel')
      if (panel) {
        panel.scrollTop = 0 // Reset scroll when opening
        const rect = panel.getBoundingClientRect()
        if (rect.bottom > window.innerHeight) {
          panelPosition.value.top = buttonPosition.value.top - rect.height - 4
        }
      }
    }, 0)
  } else {
    props.editor.commands.focus()
  }
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
  if (event.key === 'Enter' && event.shiftKey && event.ctrlKey) {
    event.preventDefault()
    event.stopImmediatePropagation()
    togglePanel()
    return true
  }

  if (panelVisible.value) {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopImmediatePropagation()
      selectedIndex.value = (selectedIndex.value - 1 + formats.length) % formats.length
      scrollToSelected()
      return true
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopImmediatePropagation()
      selectedIndex.value = (selectedIndex.value + 1) % formats.length
      scrollToSelected()
      return true
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopImmediatePropagation()
      formats[selectedIndex.value].action()
      panelVisible.value = false
      props.editor.commands.focus()
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      panelVisible.value = false
      props.editor.commands.focus()
      return true
    }
  }
  return false
}

const handleGlobalClick = (event: MouseEvent) => {
  if (panelVisible.value) {
    const target = event.target as HTMLElement
    const button = document.getElementById('inline-menu-button')
    const panel = document.getElementById('inline-panel')
    
    if (button && button.contains(target)) return
    if (panel && panel.contains(target)) return
    
    panelVisible.value = false
  }
}

onMounted(() => {
  props.editor.on('selectionUpdate', updatePosition)
  props.editor.on('update', updatePosition)
  props.editor.on('focus', updatePosition)
  props.editor.on('blur', () => {
    // Hide menu after a short delay to allow clicking the button
    setTimeout(() => {
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
      @click="togglePanel"
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
        v-for="(item, index) in formats"
        :key="item.id"
        class="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors"
        :class="{
          'bg-accent-soft text-accent': index === selectedIndex,
          'text-text-main hover:bg-accent-soft/50': index !== selectedIndex
        }"
        @click="item.action(); panelVisible = false"
        @mouseenter="selectedIndex = index"
      >
        <component :is="item.icon" :size="16" />
        <span>{{ item.label }}</span>
      </div>
    </div>
  </div>
</template>
