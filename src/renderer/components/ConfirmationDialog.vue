<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlertTriangle } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'

const workspaceStore = useWorkspaceStore()
const cancelButtonRef = ref<HTMLButtonElement | null>(null)

watch(
  () => workspaceStore.confirmationDialogOpen,
  (open) => {
    if (open) void nextTick(() => cancelButtonRef.value?.focus())
  },
)

const cancel = () => workspaceStore.cancelConfirmation()
const confirm = () => workspaceStore.acceptConfirmation()

const handleWindowKeydown = (event: KeyboardEvent) => {
  if (!workspaceStore.confirmationDialogOpen || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  cancel()
}

onMounted(() => window.addEventListener('keydown', handleWindowKeydown, { capture: true }))
onBeforeUnmount(() => window.removeEventListener('keydown', handleWindowKeydown, { capture: true }))
</script>

<template>
  <div
    v-if="workspaceStore.confirmationDialogOpen"
    class="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6"
    style="-webkit-app-region: no-drag"
    role="presentation"
    @pointerdown.self="cancel"
  >
    <section
      class="w-full max-w-md rounded-xl border border-border-soft bg-panel shadow-2xl shadow-black/25"
      role="alertdialog"
      aria-modal="true"
      :aria-label="workspaceStore.confirmationDialogTitle"
      @pointerdown.stop
    >
      <div class="flex items-start gap-3 border-b border-border-soft px-4 py-4">
        <div
          class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          :class="workspaceStore.confirmationDialogDanger ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'"
        >
          <AlertTriangle :size="18" />
        </div>
        <div class="min-w-0">
          <h2 class="text-sm font-semibold text-text-main">
            {{ workspaceStore.confirmationDialogTitle }}
          </h2>
          <p class="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-text-muted">
            {{ workspaceStore.confirmationDialogMessage }}
          </p>
        </div>
      </div>
      <div class="flex items-center justify-end gap-2 px-4 py-3">
        <button
          ref="cancelButtonRef"
          type="button"
          class="rounded-lg bg-accent-soft px-3 py-2 text-sm text-text-main hover:bg-accent-soft"
          @click="cancel"
        >
          {{ workspaceStore.confirmationDialogCancelText }}
        </button>
        <button
          type="button"
          class="rounded-lg px-3 py-2 text-sm text-white"
          :class="workspaceStore.confirmationDialogDanger ? 'bg-danger hover:bg-danger/90' : 'bg-accent hover:bg-accent-hover'"
          @click="confirm"
        >
          {{ workspaceStore.confirmationDialogConfirmText }}
        </button>
      </div>
    </section>
  </div>
</template>