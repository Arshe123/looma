<script setup lang="ts">
import { computed } from 'vue'
import {
  FileDiff,
  Loader2,
  Wrench,
} from 'lucide-vue-next'
import type { AiAssistantMessage, AiAssistantTimelineStep } from '@/renderer/stores/workspace'
import type { AgentApprovalState } from '@/renderer/stores/ai-assistant'
import AiMarkdown from './AiMarkdown.vue'
import type { AgentConversationDisplayEvent, AgentFileReviewDisplayData } from './agentConversationDisplay'
import { getAiTimelineStepDuration } from './aiTimeline'

const props = withDefaults(defineProps<{
  message: AiAssistantMessage
  events?: AgentConversationDisplayEvent[]
  approvals?: AgentApprovalState[]
}>(), {
  events: () => [],
  approvals: () => [],
})

const emit = defineEmits<{
  openDiff: [review: AgentFileReviewDisplayData]
}>()

const hasLiveEvents = computed(() => props.events.length > 0)
const fallbackSteps = computed(() => (props.message.timeline || []).filter((step) => (
  step.title.startsWith('调用 ') || step.title.startsWith('审批文件修改')
)))
const approvalById = computed(() => new Map(props.approvals.map((approval) => [approval.approvalId, approval])))

const statusLabel = (status: AgentConversationDisplayEvent['status']) => ({
  active: '执行中',
  completed: '已完成',
  error: '失败',
  pending_approval: '待审批',
  approved: '已应用',
  rejected: '已拒绝',
  expired: '已过期',
  cancelled: '已取消',
}[status])

const statusClass = (status: AgentConversationDisplayEvent['status']) => {
  if (status === 'error' || status === 'rejected' || status === 'expired') return 'text-danger'
  if (status === 'pending_approval') return 'text-warning'
  if (status === 'active') return 'text-accent'
  return 'text-success'
}

const fileStatus = (event: AgentConversationDisplayEvent) => {
  const approvalId = event.fileReview?.approvalId
  const approval = approvalId ? approvalById.value.get(approvalId) : undefined
  if (!approval) return event.status
  if (approval.status === 'pending' || approval.status === 'resolving') return 'pending_approval'
  return approval.status
}

const durationLabel = (durationMs: number) => {
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
}

const operationTimeLabel = (event: AgentConversationDisplayEvent) => {
  if (event.status === 'active') return '执行中'
  if (event.durationMs !== undefined) return durationLabel(event.durationMs)
  return statusLabel(event.status)
}

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
      <template v-for="event in events" :key="event.id">
        <div v-if="event.kind === 'thought'" class="px-1 py-1 text-sm leading-6 text-text-main">
          <AiMarkdown :content="event.content || ''" />
        </div>

        <details v-else-if="event.kind === 'tool_call'" class="group px-1">
          <summary class="inline-flex max-w-full cursor-pointer list-none items-center gap-1.5 py-0.5 text-[10px] leading-4 text-text-muted transition-colors hover:text-text-main [&::-webkit-details-marker]:hidden">
            <Loader2 v-if="event.status === 'active'" :size="11" class="shrink-0 animate-spin text-accent" />
            <Wrench v-else :size="11" class="shrink-0" :class="statusClass(event.status)" />
            <span class="truncate">{{ event.tool || event.title }}</span>
            <span class="shrink-0 text-text-subtle">· {{ operationTimeLabel(event) }}</span>
          </summary>
          <div class="ml-[17px] mt-1 border-l border-border-soft pl-2.5 text-[9px] leading-4 text-text-muted">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>状态：<span :class="statusClass(event.status)">{{ statusLabel(event.status) }}</span></span>
              <span v-if="event.content">{{ event.content }}</span>
            </div>
            <div class="mt-1.5 text-[8px] uppercase tracking-wide text-text-subtle">脱敏后的调用参数（本地持久化）</div>
            <pre class="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-md bg-panel-soft p-2 font-mono text-[9px] leading-4 text-text-main">{{ event.argumentsPreview || '{}' }}</pre>
          </div>
        </details>

        <button
          v-else-if="event.kind === 'file_review' && event.fileReview"
          type="button"
          class="flex w-full items-center gap-2.5 rounded-lg border border-border-soft bg-panel px-2.5 py-2 text-left transition-colors hover:border-accent/40 hover:bg-accent-soft/30"
          @click="emit('openDiff', event.fileReview)"
        >
          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-panel-soft text-accent"><FileDiff :size="14" /></span>
          <span class="min-w-0 flex-1">
            <strong class="block truncate text-[10px] font-semibold text-text-main">{{ event.fileReview.path.split('/').pop() }}</strong>
            <small class="mt-0.5 block truncate text-[8px] text-text-subtle">{{ event.fileReview.path }}</small>
          </span>
          <span class="text-[9px] text-success">+{{ event.fileReview.additions }}</span>
          <span class="text-[9px] text-danger">−{{ event.fileReview.deletions }}</span>
          <span class="shrink-0 text-[9px]" :class="statusClass(fileStatus(event) as AgentConversationDisplayEvent['status'])">{{ statusLabel(fileStatus(event) as AgentConversationDisplayEvent['status']) }}</span>
          <span class="text-text-subtle">›</span>
        </button>
      </template>
    </template>

    <template v-else>
      <details v-for="step in fallbackSteps" :key="step.id" class="group px-1">
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
    </template>
  </section>
</template>
