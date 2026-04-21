<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useWorkspaceStore } from '../store/workspace'

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
</script>

<template>
  <div v-if="workspaceStore.inputDialogOpen" class="fixed inset-0 z-50">
    <div class="absolute inset-0 bg-black/30" style="-webkit-app-region: no-drag" @click="cancel"></div>
    <div class="absolute inset-0 flex items-center justify-center p-6" style="-webkit-app-region: no-drag">
      <div class="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl">
        <div class="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ workspaceStore.inputDialogTitle }}</div>
        </div>
        <div class="px-4 py-4">
          <input
            ref="inputEl"
            v-model="workspaceStore.inputDialogValue"
            class="w-full px-3 py-2 rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
            :placeholder="workspaceStore.inputDialogPlaceholder"
            @keydown.enter.prevent="submit"
            @keydown.esc.prevent="cancel"
          />
        </div>
        <div class="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2">
          <button class="px-3 py-2 rounded-lg text-sm bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700" @click="cancel">
            取消
          </button>
          <button class="px-3 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white" @click="submit">
            确定
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

