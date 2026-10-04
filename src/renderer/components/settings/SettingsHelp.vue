<script setup lang="ts">
import { CircleAlert } from 'lucide-vue-next'

defineProps<{ id: string; label: string; text: string }>()
</script>

<template>
  <span class="group/settings-help relative inline-flex shrink-0 items-center align-middle">
    <button
      type="button"
      :aria-label="`${label}说明`"
      :aria-describedby="id"
      class="inline-flex h-5 w-5 items-center justify-center rounded text-text-muted transition-colors hover:text-text-main focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <CircleAlert :size="14" aria-hidden="true" />
    </button>
    <span
      :id="id"
      role="tooltip"
      class="invisible absolute left-0 top-full z-50 w-80 max-w-[calc(100vw-4rem)] pt-2 opacity-0 transition-opacity group-hover/settings-help:visible group-hover/settings-help:opacity-100 group-focus-within/settings-help:visible group-focus-within/settings-help:opacity-100"
    >
      <span class="block whitespace-pre-line rounded-lg border border-border-soft bg-panel p-3 text-left text-xs font-normal leading-5 text-text-muted shadow-lg">{{ text }}</span>
    </span>
  </span>
</template>
