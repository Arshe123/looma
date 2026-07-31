<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { AlertCircle, X } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  open: boolean
  title?: string
  message: string
  detail?: string
}>(), {
  title: '无法插入该文件',
  detail: '',
})

const emit = defineEmits<{
  (event: 'close'): void
}>()

const confirmButton = ref<HTMLButtonElement | null>(null)
const titleId = `editor-drop-alert-${Math.random().toString(36).slice(2)}`

const close = () => emit('close')
const handleKeydown = (event: KeyboardEvent) => {
  if (props.open && event.key === 'Escape') close()
}

watch(() => props.open, (open) => {
  if (open) void nextTick(() => confirmButton.value?.focus())
})

onMounted(() => window.addEventListener('keydown', handleKeydown))
onUnmounted(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[80] flex items-center justify-center bg-overlay p-4"
      role="presentation"
      @pointerdown.self="close"
    >
      <section
        class="w-full max-w-[380px] rounded-xl border border-border-soft bg-panel p-5 text-text-main shadow-2xl"
        role="alertdialog"
        aria-modal="true"
        :aria-labelledby="titleId"
      >
        <div class="flex items-start gap-3">
          <div class="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-danger/10 text-danger">
            <AlertCircle :size="17" />
          </div>
          <div class="min-w-0 flex-1">
            <h2 :id="titleId" class="text-sm font-semibold text-text-main">{{ title }}</h2>
            <p class="mt-1 text-xs leading-5 text-text-muted">{{ message }}</p>
          </div>
          <button
            type="button"
            class="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-subtle hover:bg-panel-soft hover:text-text-main"
            aria-label="关闭提示"
            title="关闭"
            @click="close"
          >
            <X :size="17" />
          </button>
        </div>

        <details v-if="detail" class="mt-3 border-t border-border-soft pt-2 text-[11px] text-text-subtle">
          <summary class="cursor-pointer select-none">技术详情</summary>
          <div class="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono leading-5">{{ detail }}</div>
        </details>

        <div class="mt-5 flex justify-end">
          <button
            ref="confirmButton"
            type="button"
            class="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent/30"
            @click="close"
          >
            知道了
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
