<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlertCircle, AlertTriangle, CircleHelp, Info } from 'lucide-vue-next'
import { normalizeMessageDialogOptions, type MessageDialogOptions } from '@/renderer/stores/message-dialog'

const props = defineProps<{ open: boolean; options: MessageDialogOptions }>()
const emit = defineEmits<{ response: [index: number] }>()
const dialogRef = ref<HTMLElement | null>(null)
const options = computed(() => normalizeMessageDialogOptions(props.options))
const icon = computed(() => ({ none: Info, info: Info, warning: AlertTriangle, error: AlertCircle, question: CircleHelp })[options.value.type])
let previousFocus: HTMLElement | null = null

const respond = (index: number) => emit('response', index)
const cancel = () => respond(options.value.cancelId)
const buttons = () => [...(dialogRef.value?.querySelectorAll<HTMLButtonElement>('[data-message-dialog-response]') ?? [])]
const isTopmost = () => [...document.querySelectorAll('[data-message-dialog]')].at(-1) === dialogRef.value?.closest('[data-message-dialog]')
const restoreFocus = () => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  previousFocus = null
}

watch(() => props.open, async open => {
  if (!open) { restoreFocus(); return }
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick()
  if (props.open) buttons()[options.value.defaultId]?.focus()
}, { immediate: true })

const handleKeydown = (event: KeyboardEvent) => {
  if (!props.open || !isTopmost()) return
  // Keep file-tree/editor shortcuts from acting behind the modal.
  event.stopImmediatePropagation()
  if (event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  } else if (event.key === 'Tab') {
    const controls = [...(dialogRef.value?.querySelectorAll<HTMLElement>('button, summary') ?? [])]
    const index = controls.indexOf(document.activeElement as HTMLElement)
    event.preventDefault()
    controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
  } else if (event.key === 'Enter' && !(event.target instanceof HTMLElement && event.target.closest('summary'))) {
    event.preventDefault()
    const index = buttons().indexOf(document.activeElement as HTMLButtonElement)
    respond(index >= 0 ? index : options.value.defaultId)
  }
}

const handleFocusIn = (event: FocusEvent) => {
  if (props.open && isTopmost() && dialogRef.value && !dialogRef.value.contains(event.target as Node)) {
    buttons()[options.value.defaultId]?.focus()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown, { capture: true })
  window.addEventListener('focusin', handleFocusIn)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown, { capture: true })
  window.removeEventListener('focusin', handleFocusIn)
  restoreFocus()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      data-message-dialog
      class="fixed inset-0 z-[10000] flex items-center justify-center bg-overlay p-6"
      style="-webkit-app-region: no-drag"
      role="presentation"
      @pointerdown.self="cancel"
    >
      <section
        ref="dialogRef"
        class="flex max-h-[calc(100dvh-3rem)] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border-soft bg-panel shadow-2xl shadow-black/25"
        role="alertdialog"
        aria-modal="true"
        :aria-label="options.title"
        @pointerdown.stop
      >
        <div class="flex min-h-0 items-start gap-3 overflow-y-auto border-b border-border-soft px-4 py-4">
          <div
            class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            :class="options.type === 'error' || options.dangerId !== undefined ? 'bg-danger/10 text-danger' : options.type === 'warning' ? 'bg-warning/10 text-warning' : 'bg-accent-soft text-accent'"
          >
            <component :is="icon" :size="18" />
          </div>
          <div class="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
            <h2 class="text-sm font-semibold text-text-main">{{ options.title }}</h2>
            <p class="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-text-muted">{{ options.message }}</p>
            <template v-if="options.detail">
              <details v-if="options.detailLabel" class="mt-3 text-xs text-text-subtle">
                <summary class="cursor-pointer select-none">{{ options.detailLabel }}</summary>
                <div class="mt-1 whitespace-pre-wrap break-all font-mono leading-5">{{ options.detail }}</div>
              </details>
              <p v-else class="mt-3 whitespace-pre-wrap text-xs leading-5 text-text-subtle">{{ options.detail }}</p>
            </template>
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 px-4 py-3">
          <button
            v-for="(label, index) in options.buttons"
            :key="index"
            type="button"
            :data-message-dialog-response="index"
            class="rounded-lg px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            :class="index === options.dangerId ? 'bg-danger text-white hover:bg-danger/90' : index === options.cancelId && options.buttons.length > 1 ? 'bg-accent-soft text-text-main hover:bg-panel-soft' : 'bg-accent text-[var(--accent-contrast)] hover:bg-accent-hover'"
            @click="respond(index)"
          >
            {{ label }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
