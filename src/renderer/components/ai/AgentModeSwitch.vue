<script setup lang="ts">
import type { AgentMode } from '@/shared/utils/app-settings'

withDefaults(defineProps<{
  modelValue: AgentMode
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [mode: AgentMode]
}>()
</script>

<template>
  <div class="flex items-center gap-0.5 rounded-lg bg-panel-soft p-0.5" aria-label="AI 模式">
    <button
      type="button"
      class="h-7 rounded-md px-2 text-[10px] text-text-subtle disabled:cursor-not-allowed"
      disabled
      title="Chat 后端后续开放"
    >
      Chat · 后续开放
    </button>
    <button
      v-for="mode in (['rag', 'agent'] as const)"
      :key="mode"
      type="button"
      class="h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      :class="modelValue === mode ? 'bg-panel text-text-main shadow-sm' : 'text-text-muted hover:text-text-main'"
      :disabled="disabled"
      :aria-pressed="modelValue === mode"
      @click="emit('update:modelValue', mode)"
    >
      {{ mode === 'rag' ? 'RAG' : 'Agent' }}
    </button>
  </div>
</template>
