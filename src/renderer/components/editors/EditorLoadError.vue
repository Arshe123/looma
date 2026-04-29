<script setup lang="ts">
const emit = defineEmits<{
  (e: 'retry'): void
}>()
</script>

<template>
  <div class="h-full w-full flex items-center justify-center p-10">
    <div class="w-[520px] max-w-[92vw] rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xl p-6 text-center">
      <div class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">编辑器加载失败，请重试</div>
      <div class="mt-4 flex items-center justify-center">
        <button
          class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm"
          @click="emit('retry')"
        >
          重试
        </button>
      </div>
    </div>
  </div>
</template>

