<script setup lang="ts">
import { FileText } from 'lucide-vue-next'
import type { AiAssistantTimelineOutput, AiAssistantTimelineStep } from '@/renderer/stores/workspace'
import { getAiTimelineStepDuration } from './aiTimeline'

const props = defineProps<{
  step: AiAssistantTimelineStep
}>()

const emit = defineEmits<{
  openSource: [output: AiAssistantTimelineOutput]
}>()

const statusLabel = (status: AiAssistantTimelineStep['status']) => ({
  pending: '等待',
  active: '进行中',
  completed: '完成',
  error: '失败',
}[status])

const statusClass = (status: AiAssistantTimelineStep['status']) => ({
  pending: 'border-border-soft bg-panel',
  active: 'border-accent bg-accent-soft',
  completed: 'border-success bg-panel',
  error: 'border-danger bg-danger/10',
}[status])

const outputText = (output: AiAssistantTimelineOutput) => {
  if (output.type === 'error' && output.technicalDetail) {
    return `${output.content || '工具执行失败。'}\n\n技术详情\n${output.technicalDetail}`
  }
  if (output.content) return output.content
  if (output.path) return output.path
  if (output.value !== undefined) return `${output.value}${output.unit || ''}`
  if (output.metadata) return JSON.stringify(output.metadata)
  return ''
}

const sourceName = (output: AiAssistantTimelineOutput) => {
  const path = output.path?.replace(/\\+/g, '/') || ''
  return path.split('/').filter(Boolean).pop() || output.title || '来源片段'
}

const sourceScore = (output: AiAssistantTimelineOutput) => {
  const score = output.metadata?.score
  if (typeof score !== 'number' || !Number.isFinite(score)) return ''
  return score >= 0 && score <= 1 ? `${Math.round(score * 100)}%` : score.toFixed(3)
}
</script>

<template>
  <article class="relative pl-7">
    <span
      class="absolute left-0 top-1 h-3 w-3 rounded-full border-2"
      :class="statusClass(step.status)"
    />
    <div class="flex items-start justify-between gap-2">
      <h3 class="text-[11px] font-semibold leading-5 text-text-main">{{ step.title }}</h3>
      <span class="shrink-0 text-[9px] leading-5 text-text-subtle">
        {{ statusLabel(step.status) }} · {{ getAiTimelineStepDuration(step) }}
      </span>
    </div>
    <p v-if="step.detail || step.description" class="mt-0.5 text-[10px] leading-4 text-text-muted">
      {{ step.detail || step.description }}
    </p>

    <div v-if="step.outputs.length" class="mt-2 space-y-1.5">
      <template v-for="output in step.outputs" :key="`${props.step.id}:${output.id}`">
        <button
          v-if="output.type === 'source'"
          type="button"
          class="flex w-full gap-2 rounded-lg border border-border-soft bg-panel p-2 text-left transition-colors hover:border-accent/40 hover:bg-accent-soft/40 disabled:cursor-default"
          :disabled="!output.path"
          @click="emit('openSource', output)"
        >
          <FileText :size="14" class="mt-0.5 shrink-0 text-accent" />
          <span class="min-w-0 flex-1">
            <span class="flex items-center justify-between gap-2">
              <strong class="truncate text-[10px] font-medium text-text-main">{{ sourceName(output) }}</strong>
              <small v-if="sourceScore(output)" class="shrink-0 text-[9px] text-accent">{{ sourceScore(output) }}</small>
            </span>
            <span v-if="output.path" class="mt-0.5 block truncate text-[9px] text-text-subtle">{{ output.path }}</span>
            <span v-if="output.content" class="mt-1 line-clamp-2 block text-[10px] leading-4 text-text-muted">{{ output.content }}</span>
          </span>
        </button>
        <details v-else class="rounded-lg border border-border-soft bg-panel text-[10px] text-text-muted">
          <summary class="cursor-pointer list-none px-2.5 py-2 font-medium text-text-main [&::-webkit-details-marker]:hidden">
            {{ output.title || (output.type === 'error' ? '错误详情' : '工具结果') }}
          </summary>
          <pre class="overflow-auto whitespace-pre-wrap break-all border-t border-border-soft bg-panel-soft p-2 font-mono leading-4">{{ outputText(output) }}</pre>
        </details>
      </template>
    </div>
  </article>
</template>
