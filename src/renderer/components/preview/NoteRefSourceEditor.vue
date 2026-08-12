<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import {
  applyMarkdownNoteRefSource,
  findNearbyNoteRef,
  type EditableNoteRef,
} from '@/shared/utils/tiptap-note-ref-insertion'
import { OPEN_NOTE_REF_EVENT } from '@/shared/utils/note-link-ref'

const props = defineProps<{ editor: Editor }>()

const visible = ref(false)
const source = ref('')
const error = ref('')
const position = ref({ left: 0, top: 0 })
const inputRef = ref<HTMLInputElement | null>(null)
let target: EditableNoteRef | null = null
let editing = false
let suppressSelectionSync = false

const formatSource = (noteRef: EditableNoteRef) => `[${noteRef.label}](${noteRef.href})`

const updatePosition = (noteRef: EditableNoteRef) => {
  const start = props.editor.view.coordsAtPos(noteRef.from)
  const end = props.editor.view.coordsAtPos(noteRef.to)
  const desiredLeft = Math.min(start.left, end.left)
  position.value = {
    left: Math.max(12, Math.min(desiredLeft, window.innerWidth - 532)),
    top: Math.min(Math.max(start.bottom + 8, 12), window.innerHeight - 90),
  }
}

const syncFromSelection = () => {
  if (editing || suppressSelectionSync || props.editor.isDestroyed) return
  const nextTarget = findNearbyNoteRef(props.editor.state)
  if (!nextTarget) {
    visible.value = false
    target = null
    error.value = ''
    return
  }
  target = nextTarget
  source.value = formatSource(nextTarget)
  error.value = ''
  updatePosition(nextTarget)
  visible.value = true
}

const apply = () => {
  if (!target || props.editor.isDestroyed) return false
  const result = applyMarkdownNoteRefSource(props.editor, target, source.value)
  if ('error' in result) {
    error.value = result.error
    void nextTick(() => inputRef.value?.focus())
    return false
  }
  error.value = ''
  visible.value = false
  editing = false
  props.editor.commands.focus()
  return true
}

const cancel = () => {
  visible.value = false
  editing = false
  error.value = ''
  props.editor.commands.focus()
}

const dismissForNavigation = () => {
  suppressSelectionSync = true
  visible.value = false
  editing = false
  error.value = ''
  target = null
}

const openForCurrentSelection = () => {
  suppressSelectionSync = false
  editing = false
  syncFromSelection()
  if (visible.value) void nextTick(() => inputRef.value?.focus())
}

const resumeSelectionSync = () => {
  suppressSelectionSync = false
}

defineExpose({ dismissForNavigation, openForCurrentSelection })

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    apply()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
}

const handleFocus = () => {
  editing = true
}

const handleBlur = () => {
  window.setTimeout(() => {
    if (!visible.value) return
    if (document.activeElement === inputRef.value) return
    if (error.value) {
      visible.value = false
      editing = false
      error.value = ''
      return
    }
    apply()
  }, 0)
}

onMounted(() => {
  props.editor.on('selectionUpdate', syncFromSelection)
  props.editor.on('update', syncFromSelection)
  window.addEventListener('resize', syncFromSelection)
  window.addEventListener(OPEN_NOTE_REF_EVENT, dismissForNavigation)
  props.editor.view.dom.addEventListener('keydown', resumeSelectionSync, true)
  syncFromSelection()
})

onBeforeUnmount(() => {
  if (!props.editor.isDestroyed) {
    props.editor.off('selectionUpdate', syncFromSelection)
    props.editor.off('update', syncFromSelection)
  }
  window.removeEventListener('resize', syncFromSelection)
  window.removeEventListener(OPEN_NOTE_REF_EVENT, dismissForNavigation)
  if (!props.editor.isDestroyed) {
    props.editor.view.dom.removeEventListener('keydown', resumeSelectionSync, true)
  }
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      data-looma-note-ref-source-editor
      class="fixed z-[9999] w-[520px] max-w-[calc(100vw-1.5rem)] rounded-lg border border-border-soft bg-panel p-2 shadow-xl"
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
    >
      <input
        ref="inputRef"
        v-model="source"
        class="w-full rounded-md border bg-panel-soft px-2.5 py-1.5 font-mono text-xs text-text-main outline-none focus:border-accent"
        :class="error ? 'border-danger' : 'border-border-soft'"
        aria-label="编辑笔记引用源码"
        @focus="handleFocus"
        @blur="handleBlur"
        @keydown="handleKeydown"
      />
      <div class="mt-1 flex min-h-4 items-center px-1 text-[11px]">
        <span v-if="error" class="text-danger" role="alert">{{ error }}</span>
        <span v-else class="text-text-subtle">Enter 保存 · Esc 取消</span>
      </div>
    </div>
  </Teleport>
</template>
