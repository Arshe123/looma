<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'

const workspaceStore = useWorkspaceStore()
const inputEl = ref<HTMLInputElement | null>(null)

watch(
  () => workspaceStore.inputDialogOpen,
  (open) => {
    if (!open) return
    nextTick(() => {
      inputEl.value?.focus()
      inputEl.value?.select()
    })
  },
)

const submit = () => {
  workspaceStore.submitTextInput()
}

const cancel = () => {
  workspaceStore.cancelTextInput()
}

const handleWindowKeydown = (event: KeyboardEvent) => {
  if (!workspaceStore.inputDialogOpen || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  cancel()
}

onMounted(() => window.addEventListener('keydown', handleWindowKeydown, { capture: true }))
onBeforeUnmount(() => window.removeEventListener('keydown', handleWindowKeydown, { capture: true }))
</script>

<template>
  <div
    v-if="workspaceStore.inputDialogOpen"
    class="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6"
    style="-webkit-app-region: no-drag"
    role="presentation"
    @pointerdown.self="cancel"
  >
    <div
      class="w-full max-w-md rounded-xl bg-panel border border-border-soft shadow-2xl shadow-black/25"
      role="dialog"
      aria-modal="true"
      :aria-label="workspaceStore.inputDialogTitle"
      @pointerdown.stop
    >
      <div class="px-4 py-3 border-b border-border-soft">
        <div class="text-sm font-semibold text-text-main">{{ workspaceStore.inputDialogTitle }}</div>
      </div>
      <div class="px-4 py-4">
        <input
          ref="inputEl"
          v-model="workspaceStore.inputDialogValue"
          class="w-full px-3 py-2 rounded-lg bg-surface border border-border-soft text-text-main placeholder:text-text-subtle text-sm outline-hidden focus:border-accent focus:ring-4 focus:ring-accent-soft"
          :placeholder="workspaceStore.inputDialogPlaceholder"
          @keydown.enter.prevent="submit"
        />
      </div>
      <div class="px-4 py-3 border-t border-border-soft flex items-center justify-end gap-2">
        <button type="button" class="px-3 py-2 rounded-lg text-sm bg-accent-soft hover:bg-accent-soft text-text-main" @click="cancel">
          取消
        </button>
        <button type="button" class="px-3 py-2 rounded-lg text-sm bg-accent hover:bg-accent-hover text-white" @click="submit">
          确定
        </button>
      </div>
    </div>
  </div>
</template>
