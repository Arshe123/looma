<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Brain, ChevronDown } from 'lucide-vue-next'
import type { MemoryUpdatedPayload } from '@/shared/types/agent-events'

const props = defineProps<{
  messageId: number
  completed: boolean
  updates: Array<{ id: string; changes: MemoryUpdatedPayload['changes']; kind?: MemoryUpdatedPayload['kind']; workspaceId?: string }>
}>()
const expanded = ref<Record<string, boolean>>({})
const groups = computed(() => {
  const result = new Map<string, { key: string; label: string; additions: Array<{ id: string; text: string }> }>()
  for (const update of props.updates) {
    const key = `${update.kind ?? 'legacy'}-${update.workspaceId ?? ''}`
    const group = result.get(key) ?? { key, label: update.kind === 'workspace' ? '工作空间记忆已更新' : update.kind === 'user' ? '用户画像已更新' : '记忆已更新', additions: [] }
    group.additions.push(...update.changes.flatMap((change, index) => change.type === 'added' ? [{ id: `${update.id}-${index}`, text: change.text }] : []))
    result.set(key, group)
  }
  return [...result.values()]
})
watch(() => props.messageId, () => { expanded.value = {} })
</script>

<template>
  <section v-if="completed && updates.length" class="memory-update-notice mt-3 text-xs text-text-muted" aria-label="记忆更新">
    <div v-for="group in groups" :key="group.key">
    <button
      v-if="group.additions.length"
      type="button"
      class="inline-flex items-center gap-1 py-1 transition-colors hover:text-text-main focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      :aria-expanded="!!expanded[group.key]"
      :aria-controls="`memory-changes-${messageId}-${group.key}`"
      @click="expanded[group.key] = !expanded[group.key]"
    >
      <Brain :size="13" aria-hidden="true" />
      <span>{{ group.label }}</span>
      <ChevronDown :size="13" class="transition-transform" :class="{ 'rotate-180': expanded[group.key] }" aria-hidden="true" />
    </button>
    <span v-else class="inline-flex items-center gap-1 py-1"><Brain :size="13" aria-hidden="true" /><span>{{ group.label }}</span></span>
    <div v-if="group.additions.length" :id="`memory-changes-${messageId}-${group.key}`" v-show="expanded[group.key]" class="mt-1 max-h-72 space-y-3 overflow-auto border-l border-border-soft pl-3">
      <pre v-for="addition in group.additions" :key="addition.id" class="whitespace-pre-wrap break-all rounded bg-panel-soft p-2 font-mono text-xs text-text-main">{{ addition.text || '（空行）' }}</pre>
    </div>
    </div>
  </section>
</template>
