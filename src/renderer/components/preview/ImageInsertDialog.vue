<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import { ArrowDown, CornerDownLeft, FolderOpen, ImagePlus, Keyboard, X } from 'lucide-vue-next'
import { insertMarkdownImageTemplate } from '@/shared/utils/tiptap-image-insertion'

const props = defineProps<{
  open: boolean
  editor: Editor
  filePath: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

type ImageSource = 'path' | 'file'

const selectedSource = ref<ImageSource>('path')
const loading = ref(false)
const errorMessage = ref('')
const technicalDetail = ref('')

const close = () => {
  if (loading.value) return
  emit('close')
}

const resetError = () => {
  errorMessage.value = ''
  technicalDetail.value = ''
}

const insertFromPath = () => {
  resetError()
  if (!insertMarkdownImageTemplate(props.editor)) {
    errorMessage.value = '暂时无法在当前位置插入图片，请重新定位光标后再试。'
    technicalDetail.value = 'The editor rejected the Markdown image template insertion.'
    return
  }
  emit('close')
}

const insertFromFile = async () => {
  resetError()
  loading.value = true
  try {
    const result = await window.electronAPI.file.selectAndCopyImage(props.filePath)
    if (!result.success) {
      errorMessage.value = '图片导入失败，请确认图片仍然存在且当前笔记目录可写。'
      technicalDetail.value = result.error || 'Unknown image import error.'
      return
    }
    if (!result.data) {
      emit('close')
      return
    }
    if (props.editor.isDestroyed || !props.editor.chain().focus().setImage({
      src: result.data.relativePath,
      alt: result.data.fileName,
    }).run()) {
      errorMessage.value = '图片已复制，但无法插入当前光标位置。请重新定位光标后再试。'
      technicalDetail.value = `Copied image path: ${result.data.relativePath}`
      return
    }
    emit('close')
  } catch (error) {
    errorMessage.value = '无法打开图片选择器，请重试。'
    technicalDetail.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

const choose = async (source: ImageSource) => {
  selectedSource.value = source
  if (source === 'path') insertFromPath()
  else await insertFromFile()
}

const handleKeyDown = (event: KeyboardEvent) => {
  if (!props.open || loading.value) return
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault()
    selectedSource.value = selectedSource.value === 'path' ? 'file' : 'path'
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    void choose(selectedSource.value)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    selectedSource.value = 'path'
    resetError()
  },
)

onMounted(() => document.addEventListener('keydown', handleKeyDown, { capture: true }))
onBeforeUnmount(() => document.removeEventListener('keydown', handleKeyDown, { capture: true }))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[80] flex items-center justify-center bg-overlay p-6"
      role="presentation"
      @pointerdown.self="close"
    >
      <section
        class="w-full max-w-md overflow-hidden rounded-xl border border-border-soft bg-panel shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="insert-image-title"
        @pointerdown.stop
      >
        <header class="flex items-center justify-between px-4 pb-2 pt-4">
          <div class="flex items-center gap-2.5">
            <ImagePlus :size="18" class="text-accent" />
            <h2 id="insert-image-title" class="text-sm font-semibold text-text-main">插入图片</h2>
          </div>
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main disabled:opacity-50"
            :disabled="loading"
            title="关闭"
            @click="close"
          >
            <X :size="16" />
          </button>
        </header>

        <div v-if="errorMessage" class="mx-3 mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          <div>{{ errorMessage }}</div>
          <details v-if="technicalDetail" class="mt-1.5 text-text-muted">
            <summary class="cursor-pointer">技术详情</summary>
            <div class="mt-1 break-all font-mono text-[11px]">{{ technicalDetail }}</div>
          </details>
        </div>

        <div class="space-y-1 px-2 pb-2">
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors"
            :class="selectedSource === 'path' ? 'bg-accent-soft text-text-main' : 'text-text-main hover:bg-panel-soft'"
            :disabled="loading"
            @mouseenter="selectedSource = 'path'"
            @click="choose('path')"
          >
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-panel text-accent shadow-sm">
              <Keyboard :size="16" />
            </span>
            <span class="min-w-0 flex-1">
              <strong class="block text-sm font-medium">输入图片路径</strong>
              <span class="block text-xs text-text-muted">插入 Markdown 图片格式并将光标定位到路径处</span>
            </span>
            <span class="inline-flex items-center gap-1 rounded border border-border-soft bg-panel-soft px-1.5 py-0.5 text-[10px] text-text-subtle">
              <CornerDownLeft :size="11" /> Enter
            </span>
          </button>

          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors"
            :class="selectedSource === 'file' ? 'bg-accent-soft text-text-main' : 'text-text-main hover:bg-panel-soft'"
            :disabled="loading"
            @mouseenter="selectedSource = 'file'"
            @click="choose('file')"
          >
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-panel text-accent shadow-sm">
              <FolderOpen :size="16" />
            </span>
            <span class="min-w-0 flex-1">
              <strong class="block text-sm font-medium">打开文件选择器</strong>
              <span class="block text-xs text-text-muted">复制到当前笔记同目录的 assets 并插入相对路径</span>
            </span>
            <span v-if="loading" class="text-xs text-text-muted">正在导入…</span>
            <ArrowDown v-else :size="14" class="text-text-subtle" />
          </button>
        </div>

        <footer class="flex items-center gap-3 border-t border-border-soft bg-panel-soft px-4 py-2 text-[10px] text-text-subtle">
          <span>↑↓ 切换</span>
          <span>Enter 选择</span>
          <span>Esc 关闭</span>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
