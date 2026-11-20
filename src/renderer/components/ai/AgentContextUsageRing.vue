<script setup lang="ts">
import { computed, useId } from 'vue'
import type { AgentContextUsage } from '@/shared/types/agent-context'
import { formatContextTokens } from '@/shared/utils/context-token-size'

const props = defineProps<{
  usage?: AgentContextUsage
  fallbackLimitTokens: number
}>()

const tooltipId = useId()

const partLabels = {
  system: '系统提示',
  memory: '记忆',
  history: '对话历史',
  input: '当前输入',
  tools: '工具',
  outputReserve: '输出预留',
} satisfies Record<keyof AgentContextUsage['parts'], string>

const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 })
const fraction = computed(() => props.usage ? props.usage.usedTokens / props.usage.limitTokens : 0)
const ringPercent = computed(() => Math.min(100, Math.max(0, fraction.value * 100)))
</script>

<template>
  <div class="group/usage-ring relative shrink-0">
    <span
      class="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-accent-soft"
      role="img"
      aria-label="上下文用量"
      :aria-describedby="tooltipId"
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="2" class="text-border-soft" />
        <circle
          v-if="ringPercent > 0"
          cx="10"
          cy="10"
          r="7.5"
          stroke="currentColor"
          stroke-width="2"
          pathLength="100"
          transform="rotate(-90 10 10)"
          :stroke-dasharray="`${ringPercent} 100`"
          :class="fraction >= 1 ? 'text-warning' : 'text-accent'"
        />
      </svg>
    </span>
    <div
      :id="tooltipId"
      role="tooltip"
      class="invisible absolute right-0 bottom-full w-[216px] rounded-xl border border-border-soft bg-surface px-3 py-2.5 text-xs leading-5 text-text-main shadow-lg group-hover/usage-ring:visible"
    >
      <p class="font-semibold">上下文用量</p>
      <template v-if="usage">
        <p class="tabular-nums">
          {{ usage.estimated ? '估算：' : '' }}{{ formatContextTokens(usage.usedTokens) }} / {{ formatContextTokens(usage.limitTokens) }} Token（{{ percent.format(fraction) }}）
        </p>
        <dl class="mt-1.5 space-y-0.5 border-t border-border-soft pt-1.5">
          <div v-for="(label, key) in partLabels" :key="key" class="flex justify-between gap-2">
            <dt class="text-text-muted">{{ label }}</dt>
            <dd class="tabular-nums">{{ formatContextTokens(usage.parts[key]) }}（{{ percent.format(usage.parts[key] / usage.limitTokens) }}）</dd>
          </div>
        </dl>
      </template>
      <template v-else>
        <p class="text-text-muted">等待用量数据</p>
        <p>上下文大小：{{ formatContextTokens(fallbackLimitTokens) }} Token</p>
      </template>
    </div>
  </div>
</template>
