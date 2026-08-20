<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, ref, watch } from 'vue'
import { Minus, Plus, WrapText } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import Editor from './Editor.vue'

const props = defineProps<{
  filePath: string
  relativeFilePath: string
  content: string
  saveTrigger: number
}>()

const emit = defineEmits<{
  (e: 'update:content', value: string): void
  (e: 'save', value: string): void
}>()

const workspaceStore = useWorkspaceStore()
const localContent = ref(props.content || '')
const fontSize = ref(14)
const wordWrap = ref(true)
const editorRef = ref<InstanceType<typeof Editor> | null>(null)
let hasActivatedOnce = false
let restoreGeneration = 0

const saveSnapshot = (skipSaveMeta = false) => {
  if (workspaceStore.isWorkspaceTransitioning) return
  const cmSnap = editorRef.value?.getSnapshot()
  if (!cmSnap || !props.relativeFilePath) return
  workspaceStore.saveFileSession(props.relativeFilePath, {
    plaintext: { fontSize: fontSize.value, wordWrap: wordWrap.value },
    codemirror: cmSnap,
  }, skipSaveMeta)
}

const restoreSnapshot = async (focusEditor = false) => {
  const generation = ++restoreGeneration
  const snapshot = workspaceStore.fileSessions[props.relativeFilePath]?.codemirror
  if (!snapshot) return
  await nextTick()
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (generation !== restoreGeneration) return
      editorRef.value?.applySnapshot(snapshot, { focus: focusEditor })
    })
  })
}

onMounted(() => {
  const session = workspaceStore.fileSessions[props.relativeFilePath]
  if (!session) return

  if (session.plaintext) {
    fontSize.value = session.plaintext.fontSize
    wordWrap.value = session.plaintext.wordWrap
  }
  void restoreSnapshot(false)
})

onActivated(() => {
  if (!hasActivatedOnce) {
    hasActivatedOnce = true
    return
  }
  void restoreSnapshot(true)
})

onDeactivated(() => {
  restoreGeneration += 1
})

watch([fontSize, wordWrap], ([fs, ww]) => {
  if (workspaceStore.isWorkspaceTransitioning) return
  workspaceStore.saveFileSession(props.relativeFilePath, {
    plaintext: { fontSize: fs, wordWrap: ww },
  })
})

const statsText = computed(() => {
  const text = localContent.value || ''
  const chars = text.length
  const lines = text.length ? text.split('\n').length : 0
  return `${chars} chars | ${lines} lines`
})

watch(
  () => props.content,
  (next) => {
    if (next === localContent.value) return
    localContent.value = next || ''
  },
)

watch(
  () => props.saveTrigger,
  () => {
    emit('save', localContent.value)
  },
)

const increaseFont = () => {
  fontSize.value = Math.min(24, fontSize.value + 1)
}

const decreaseFont = () => {
  fontSize.value = Math.max(10, fontSize.value - 1)
}

const toggleWrap = () => {
  wordWrap.value = !wordWrap.value
}

defineExpose({
  saveSnapshot(skipSaveMeta = false) {
    saveSnapshot(skipSaveMeta)
  },
})
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden relative">
    <div class="absolute top-2 right-4 z-10 text-xs text-text-subtle bg-panel/70 px-2 py-1 rounded backdrop-blur-xs pointer-events-none">
      {{ statsText }}
    </div>

    <div class="flex-1 overflow-hidden">
      <Editor
        ref="editorRef"
        mode="plaintext"
        :initialContent="localContent"
        :filePath="props.filePath"
        :fontSize="fontSize"
        :wordWrap="wordWrap"
        @change="(v) => { localContent = v; emit('update:content', v) }"
        @save="(v) => { localContent = v; emit('save', v) }"
      />
    </div>

    <div class="absolute bottom-6 right-6 flex items-center gap-1 bg-panel/90 backdrop-blur-xs p-1.5 rounded-xl border border-border-soft shadow-lg z-20">
      <div class="flex items-center gap-0.5 px-1 border-r border-border-soft mr-0.5">
        <button
          @click="decreaseFont"
          class="p-1.5 rounded-lg transition-all duration-200 text-text-muted hover:text-text-main hover:bg-accent-soft"
          title="减小字体大小"
        >
          <Minus :size="16" />
        </button>
        <span class="text-xs text-text-muted w-6 text-center select-none">{{ fontSize }}</span>
        <button
          @click="increaseFont"
          class="p-1.5 rounded-lg transition-all duration-200 text-text-muted hover:text-text-main hover:bg-accent-soft"
          title="增大字体大小"
        >
          <Plus :size="16" />
        </button>
      </div>

      <button
        @click="toggleWrap"
        :class="[
          'p-2 rounded-lg transition-all duration-200',
          wordWrap ? 'bg-accent-soft text-accent shadow-xs' : 'text-text-muted hover:text-text-main hover:bg-accent-soft'
        ]"
        :title="wordWrap ? '禁用换行' : '启用换行'"
      >
        <WrapText :size="18" />
      </button>
    </div>
  </div>
</template>
