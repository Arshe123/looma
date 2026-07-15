<script setup lang="ts">
import { X } from 'lucide-vue-next'
import type { AiAssistantTimelineOutput } from '@/renderer/stores/workspace'
import type { AgentUiState } from './agentUiState'
import AgentErrorDetails from './AgentErrorDetails.vue'
import AgentToolStep from './AgentToolStep.vue'

withDefaults(defineProps<{
  open: boolean
  state: AgentUiState
}>(), {
  open: false,
})

const emit = defineEmits<{
  close: []
  openSource: [output: AiAssistantTimelineOutput]
}>()
</script>

<template>
  <aside
    v-if="open"
    class="absolute inset-y-0 right-0 z-30 flex w-[340px] flex-col border-l border-border-soft bg-panel shadow-xl"
    aria-label="Agent 执行过程"
  >
    <header class="flex h-[58px] shrink-0 items-center justify-between border-b border-border-soft px-3.5">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <h2 class="text-xs font-semibold text-text-main">执行过程</h2>
          <span class="rounded-full bg-panel-soft px-2 py-0.5 text-[9px] text-text-muted">{{ state.statusLabel }}</span>
        </div>
        <p class="mt-1 truncate text-[9px] text-text-subtle">
          {{ state.timeline.length }} 步
          <template v-if="state.message?.runId"> · {{ state.message.runId }}</template>
        </p>
      </div>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-panel-soft hover:text-text-main"
        aria-label="关闭执行过程"
        @click="emit('close')"
      >
        <X :size="15" />
      </button>
    </header>

    <div class="flex items-center gap-2 border-b border-border-soft px-3.5 py-2 text-[10px] text-text-muted">
      <span>{{ state.toolCallCount }} 次工具调用</span>
      <span class="text-text-subtle">·</span>
      <span>{{ state.sourceCount }} 个来源</span>
      <span v-if="state.modelIdentity" class="min-w-0 truncate text-text-subtle">· {{ state.modelIdentity.displayName }}</span>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-3.5 py-4">
      <AgentErrorDetails
        :message="state.errorMessage"
        :technical-detail="state.technicalDetail"
      />
      <div
        v-if="state.timeline.length"
        class="relative mt-3 space-y-4 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-border-soft"
      >
        <AgentToolStep
          v-for="step in state.timeline"
          :key="step.id"
          :step="step"
          @open-source="emit('openSource', $event)"
        />
      </div>
      <div v-else class="flex min-h-40 items-center justify-center text-center text-[11px] leading-5 text-text-muted">
        选择带有执行过程的回答后，详情会显示在这里。
      </div>
    </div>

    <footer class="shrink-0 border-t border-border-soft px-3.5 py-2 text-[9px] text-text-subtle">
      过程与回答分开展示 · 本地工作空间
    </footer>
  </aside>
</template>
