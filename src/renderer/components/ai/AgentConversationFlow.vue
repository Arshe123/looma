<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDown, Loader2, Wrench } from 'lucide-vue-next'
import type { AiAssistantMessage, AiAssistantTimelineStep } from '@/renderer/stores/workspace'
import type { AgentApprovalState } from '@/renderer/stores/ai-assistant'
import AgentConversationEventList from './AgentConversationEventList.vue'
import type { AgentConversationDisplayEvent, AgentFileReviewDisplayData } from './agentConversationDisplay'
import { partitionAgentConversationEvents } from './agentConversationDisplay'
import { getAiTimelineStepDuration } from './aiTimeline'

const props = withDefaults(defineProps<{
  message: AiAssistantMessage
  events?: AgentConversationDisplayEvent[]
  approvals?: AgentApprovalState[]
  completed?: boolean
}>(), {
  events: () => [],
  approvals: () => [],
  completed: false,
})

const emit = defineEmits<{
  openDiff: [review: AgentFileReviewDisplayData]
}>()

const hasLiveEvents = computed(() => props.events.length > 0)
const fallbackSteps = computed(() => (props.message.timeline || []).filter((step) => (
  step.title.startsWith('调用 ') || step.title.startsWith('审批文件修改')
)))
const partitionedEvents = computed(() => partitionAgentConversationEvents(props.events, props.completed))
const totalToolCalls = computed(() => props.events.filter((event) => event.kind === 'tool_call').length)
const collapsedToolCalls = computed(() => partitionedEvents.value.collapsed.filter((event) => event.kind === 'tool_call').length)

const timelineOperationTimeLabel = (step: AiAssistantTimelineStep) => {
  if (step.status === 'active') return '执行中'
  const duration = getAiTimelineStepDuration(step)
  if (duration) return duration
  if (step.status === 'completed') return '已完成'
  if (step.status === 'error') return '失败'
  return '待执行'
}

const getPersistedArgumentsPreview = (step: AiAssistantTimelineStep) => (
  step.outputs.find((output) => output.title === '调用参数' && typeof output.content === 'string')?.content || '{}'
)
</script>

<template>
  <section v-if="hasLiveEvents || fallbackSteps.length" class="mb-3 space-y-2.5" aria-label="Agent 对话内执行过程">
    <template v-if="hasLiveEvents">
      <details v-if="partitionedEvents.collapsed.length" class="group px-1">
        <summary class="inline-flex max-w-full cursor-pointer list-none items-center gap-1.5 py-1 text-[10px] leading-4 text-text-muted transition-colors hover:text-text-main [&::-webkit-details-marker]:hidden">
          <Wrench :size="11" class="shrink-0 text-success" />
          <span>{{ completed ? `已完成 ${totalToolCalls} 次工具调用` : `较早的 ${collapsedToolCalls} 次工具调用` }}</span>
          <span class="text-text-subtle">· 点击展开</span>
          <ChevronDown :size="11" class="shrink-0 transition-transform group-open:rotate-180" />
        </summary>
        <div class="mt-1 space-y-2.5 border-l border-border-soft pl-2">
          <AgentConversationEventList
            :events="partitionedEvents.collapsed"
            :approvals="approvals"
            @open-diff="emit('openDiff', $event)"
          />
        </div>
      </details>

      <AgentConversationEventList
        v-if="partitionedEvents.visible.length"
        :events="partitionedEvents.visible"
        :approvals="approvals"
        @open-diff="emit('openDiff', $event)"
      />
    </template>

    <details v-else class="group px-1">
      <summary class="inline-flex max-w-full cursor-pointer list-none items-center gap-1.5 py-1 text-[10px] leading-4 text-text-muted transition-colors hover:text-text-main [&::-webkit-details-marker]:hidden">
        <Wrench :size="11" class="shrink-0 text-success" />
        <span>已完成 {{ fallbackSteps.length }} 次工具调用</span>
        <span class="text-text-subtle">· 点击展开</span>
        <ChevronDown :size="11" class="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div class="mt-1 space-y-2.5 border-l border-border-soft pl-2">
        <details v-for="step in fallbackSteps" :key="step.id" class="group/step px-1">
          <summary class="inline-flex max-w-full cursor-pointer list-none items-center gap-1.5 py-0.5 text-[10px] leading-4 text-text-muted transition-colors hover:text-text-main [&::-webkit-details-marker]:hidden">
            <Loader2 v-if="step.status === 'active'" :size="11" class="shrink-0 animate-spin text-accent" />
            <Wrench v-else :size="11" class="shrink-0" :class="step.status === 'error' ? 'text-danger' : 'text-success'" />
            <span class="truncate">{{ step.title.replace(/^调用\s+/, '') }}</span>
            <span class="shrink-0 text-text-subtle">· {{ timelineOperationTimeLabel(step) }}</span>
          </summary>
          <div class="ml-[17px] mt-1 border-l border-border-soft pl-2.5 text-[9px] leading-4 text-text-muted">
            <div class="text-[8px] uppercase tracking-wide text-text-subtle">脱敏后的调用参数（本地持久化）</div>
            <pre class="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-md bg-panel-soft p-2 font-mono text-[9px] leading-4 text-text-main">{{ getPersistedArgumentsPreview(step) }}</pre>
          </div>
        </details>
      </div>
    </details>
  </section>
</template>
