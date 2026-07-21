<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ExternalLink, Search } from 'lucide-vue-next'
import type { AiAssistantMessage } from '@/renderer/stores/workspace'
import {
  formatAgentRagSourceScore,
  getAgentRagSources,
  type AgentRagSourceDisplayItem,
} from './agentRagSources'

const props = defineProps<{
  message: AiAssistantMessage
}>()

const emit = defineEmits<{
  openSource: [source: AgentRagSourceDisplayItem]
}>()

const sources = computed(() => getAgentRagSources(props.message))
const selectedSourceId = ref('')
const selectedSource = computed(() => sources.value.find(source => source.id === selectedSourceId.value) || null)

watch(() => props.message.id, () => {
  selectedSourceId.value = ''
})

const toggleSource = (source: AgentRagSourceDisplayItem) => {
  selectedSourceId.value = selectedSourceId.value === source.id ? '' : source.id
}
</script>

<template>
  <section v-if="sources.length" class="mt-4 border-t border-border-soft pt-3" aria-label="RAG 检索来源">
    <div class="mb-2 flex items-center justify-between gap-2">
      <div class="inline-flex items-center gap-1.5 text-[10px] font-medium text-text-muted">
        <Search :size="11" />
        参考来源
      </div>
      <span class="text-[9px] text-text-subtle">{{ sources.length }} 条</span>
    </div>

    <div class="flex flex-wrap gap-1.5">
      <button
        v-for="source in sources"
        :key="source.id"
        type="button"
        class="inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-1 text-[9px] leading-3.5 transition-colors"
        :class="selectedSourceId === source.id
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-border-soft text-text-muted hover:border-accent/60 hover:text-text-main'"
        :aria-expanded="selectedSourceId === source.id"
        @click="toggleSource(source)"
      >
        <strong class="font-semibold text-accent">[{{ source.index }}]</strong>
        <span class="max-w-52 truncate">{{ source.title }}</span>
        <span v-if="formatAgentRagSourceScore(source.score)" class="shrink-0 text-text-subtle">
          {{ formatAgentRagSourceScore(source.score) }}
        </span>
      </button>
    </div>

    <div
      v-if="selectedSource"
      class="mt-2 rounded-lg border border-border-soft bg-panel-soft px-2.5 py-2 text-[10px] leading-4 text-text-muted"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="truncate font-medium text-text-main">{{ selectedSource.title }}</div>
          <div v-if="selectedSource.path" class="mt-0.5 break-all text-[9px] text-text-subtle">{{ selectedSource.path }}</div>
        </div>
        <button
          v-if="selectedSource.path"
          type="button"
          class="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[9px] text-accent transition-colors hover:bg-accent-soft"
          @click="emit('openSource', selectedSource)"
        >
          <ExternalLink :size="10" />
          在工作区打开
        </button>
      </div>
      <p v-if="selectedSource.content" class="mt-2 whitespace-pre-wrap break-words">{{ selectedSource.content }}</p>
      <p v-else class="mt-2 text-text-subtle">该来源没有可展示的检索片段。</p>
    </div>
  </section>
</template>
