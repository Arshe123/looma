<script setup lang="ts">
defineProps<{
  items: readonly string[]
}>()
</script>

<template>
  <div class="space-y-3">
    <label
      v-for="item in items"
      :key="item"
      class="flex items-center justify-between gap-4 rounded-md bg-panel-soft px-4 py-3 text-sm text-text-main"
    >
      <span class="min-w-0 truncate">{{ item }}</span>
      <input type="checkbox" class="h-4 w-4 shrink-0 accent-[var(--color-accent)]" />
    </label>
  </div>
</template>
