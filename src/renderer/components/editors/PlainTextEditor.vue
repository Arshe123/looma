<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Editor from '../Editor.vue'
import { WrapText, Minus, Plus } from 'lucide-vue-next'

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
  <div class="h-full flex flex-col overflow-hidden relative">
    <div class="absolute top-2 right-4 z-10 text-xs text-zinc-400 dark:text-zinc-500 bg-white/50 dark:bg-zinc-900/50 px-2 py-1 rounded backdrop-blur-sm pointer-events-none">
      {{ statsText }}
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

    <!-- Floating View Mode Controls -->
    <div class="absolute bottom-6 right-6 flex items-center gap-1 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm p-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 shadow-lg z-20">
      <div class="flex items-center gap-0.5 px-1 border-r border-zinc-200 dark:border-zinc-700 mr-0.5">
        <button 
          @click="decreaseFont"
          class="p-1.5 rounded-lg transition-all duration-200 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
          title="减小字号"
        >
          <Minus :size="16" />
        </button>
        <span class="text-xs text-zinc-500 w-6 text-center select-none">{{ fontSize }}</span>
        <button 
          @click="increaseFont"
          class="p-1.5 rounded-lg transition-all duration-200 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
          title="增大字号"
        >
          <Plus :size="16" />
        </button>
      </div>

      <button 
        @click="toggleWrap"
        :class="[
          'p-2 rounded-lg transition-all duration-200',
          wordWrap ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700'
        ]"
        :title="wordWrap ? '关闭自动换行' : '开启自动换行'"
      >
        <WrapText :size="18" />
      </button>
    </div>
  </div>
</template>

