<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import Editor from './Editor.vue'
import Preview from '../preview/Preview.vue'
import { Columns, Eye, Edit3 } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../store/workspace'

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
const viewMode = ref<'split' | 'editor' | 'preview'>('split')
const editorRef = ref<InstanceType<typeof Editor> | null>(null)

onMounted(() => {
  const session = workspaceStore.fileSessions[props.relativeFilePath]
  if (session) {
    if (session.markdown?.viewMode) {
      viewMode.value = session.markdown.viewMode
    }
    if (session.codemirror && editorRef.value) {
      // Small delay to ensure Editor is fully mounted and DOM has layout
      setTimeout(() => {
        editorRef.value?.applySnapshot(session.codemirror!)
      }, 50)
    }
  }
})

watch(viewMode, (newVal) => {
  if (workspaceStore.isWorkspaceTransitioning) return
  workspaceStore.saveFileSession(props.relativeFilePath, {
    markdown: { viewMode: newVal }
  })
})

watch(
  () => props.saveTrigger,
  () => {
    emit('save', props.content)
  },
)

defineExpose({
  saveSnapshot(skipSaveMeta = false) {
    if (workspaceStore.isWorkspaceTransitioning) return
    const cmSnap = editorRef.value?.getSnapshot()
    if (cmSnap && props.relativeFilePath) {
      workspaceStore.saveFileSession(props.relativeFilePath, {
        markdown: { viewMode: viewMode.value },
        codemirror: cmSnap
      }, skipSaveMeta)
    }
  }
})
</script>

<template>
  <div class="h-full w-full relative flex overflow-hidden">
    <div v-if="viewMode !== 'preview'" class="flex-1 overflow-hidden">
      <Editor
        ref="editorRef"
        :initialContent="props.content"
        :filePath="props.filePath"
        @change="(v) => emit('update:content', v)"
        @save="(v) => emit('save', v)"
      />
    </div>
    <div v-if="viewMode !== 'editor'" class="flex-1 overflow-hidden border-l border-zinc-200 dark:border-zinc-800">
      <Preview :content="props.content" />
    </div>

    <!-- Floating View Mode Controls -->
    <div class="absolute bottom-6 right-6 flex items-center gap-1 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm p-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 shadow-lg z-20">
      <button 
        @click="viewMode = 'editor'"
        :class="[
          'p-2 rounded-lg transition-all duration-200',
          viewMode === 'editor' ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700'
        ]"
        title="仅编辑"
      >
        <Edit3 :size="18" />
      </button>
      <button 
        @click="viewMode = 'split'"
        :class="[
          'p-2 rounded-lg transition-all duration-200',
          viewMode === 'split' ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700'
        ]"
        title="分栏"
      >
        <Columns :size="18" />
      </button>
      <button 
        @click="viewMode = 'preview'"
        :class="[
          'p-2 rounded-lg transition-all duration-200',
          viewMode === 'preview' ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700'
        ]"
        title="仅预览"
      >
        <Eye :size="18" />
      </button>
    </div>
  </div>
</template>

