<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Brain, ChevronDown } from 'lucide-vue-next'
import type { MemoryUpdatedPayload } from '@/shared/types/agent-events'

const props = defineProps<{
  messageId: number
  completed: boolean
  updates: Array<{ id: string; changes: MemoryUpdatedPayload['changes'] }>
}>()
const expanded = ref(false)
const additions = computed(() => props.updates.flatMap(update =>
  update.changes.flatMap((change, index) => change.type === 'added'
    ? [{ id: `${update.id}-${index}`, text: change.text }]
    : []),
))
watch(() => props.messageId, () => { expanded.value = false })
</script>

<template>
  <section v-if="completed && updates.length" class="memory-update-notice mt-3 text-xs text-text-muted" aria-label="记忆更新">
    <button
      type="button"
      class="inline-flex items-center gap-1 py-1 transition-colors hover:text-text-main focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      :aria-expanded="expanded"
      :aria-controls="`memory-changes-${messageId}`"
      @click="expanded = !expanded"
    >
      <Brain :size="13" aria-hidden="true" />
      <span>记忆已更新</span>
      <ChevronDown :size="13" class="transition-transform" :class="{ 'rotate-180': expanded }" aria-hidden="true" />
    </button>
    <div :id="`memory-changes-${messageId}`" v-show="expanded" class="mt-1 max-h-72 space-y-3 overflow-auto border-l border-border-soft pl-3">
      <pre v-for="addition in additions" :key="addition.id" class="whitespace-pre-wrap break-all rounded bg-panel-soft p-2 font-mono text-xs text-text-main">{{ addition.text || '（空行）' }}</pre>
    </div>
  </section>
</template>
