<script setup lang="ts">
const emit = defineEmits<{
  (e: 'retry'): void
}>()
</script>

<template>
  <div class="h-full w-full flex items-center justify-center p-10">
    <div class="w-[520px] max-w-[92vw] rounded-xl border border-border-soft bg-panel shadow-xl p-6 text-center">
      <div class="text-sm font-semibold text-text-main">编辑器加载失败。</div>
      <div class="mt-4 flex items-center justify-center">
        <button
          class="px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm"
          @click="emit('retry')"
        >
          重试
        </button>
      </div>
    </div>
  </div>
</template>
