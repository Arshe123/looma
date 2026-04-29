<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Editor from '../Editor.vue'

const props = defineProps<{
  filePath: string
  content: string
  saveTrigger: number
}>()

const emit = defineEmits<{
  (e: 'update:content', value: string): void
  (e: 'save', value: string): void
}>()

const localContent = ref(props.content || '')
const fontSize = ref(14)
const wordWrap = ref(true)

const statsText = computed(() => {
  const text = localContent.value || ''
  const chars = text.length
  const lines = text.length ? text.split('\n').length : 0
  return `${chars} 字符 · ${lines} 行`
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

const onInput = (e: Event) => {
  const v = (e.target as HTMLTextAreaElement).value
  localContent.value = v
  emit('update:content', v)
}

const increaseFont = () => {
  fontSize.value = Math.min(24, fontSize.value + 1)
}

const decreaseFont = () => {
  fontSize.value = Math.max(10, fontSize.value - 1)
}

const toggleWrap = () => {
  wordWrap.value = !wordWrap.value
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div class="h-12 px-4 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
      <div class="flex items-center gap-2">
        <button
          class="px-2 py-1 rounded-md bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 text-sm"
          @click="decreaseFont"
          title="减小字号"
        >
          A-
        </button>
        <button
          class="px-2 py-1 rounded-md bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 text-sm"
          @click="increaseFont"
          title="增大字号"
        >
          A+
        </button>
        <button
          class="px-2 py-1 rounded-md bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 text-sm"
          @click="toggleWrap"
          title="自动换行"
        >
          {{ wordWrap ? '换行：开' : '换行：关' }}
        </button>
      </div>

      <div class="text-xs text-zinc-500 dark:text-zinc-400">{{ statsText }}</div>
    </div>

    <div class="flex-1 overflow-hidden">
      <Editor
        mode="plaintext"
        :initialContent="localContent"
        :filePath="props.filePath"
        :fontSize="fontSize"
        :wordWrap="wordWrap"
        @change="(v) => { localContent = v; emit('update:content', v) }"
        @save="(v) => { localContent = v; emit('save', v) }"
      />
    </div>
  </div>
</template>

