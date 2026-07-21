<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-vue-next'
import type { AgentRecoveryState } from '@/renderer/stores/ai-assistant'

const props = defineProps<{
  recovery: AgentRecoveryState
  disabled?: boolean
}>()

const emit = defineEmits<{ continue: [] }>()
const expanded = ref(false)
const title = computed(() => props.recovery.continuedToRunId ? '已创建后续运行' : '本次运行已中断')
</script>

<template>
  <section class="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
    <div class="flex items-start gap-3 px-3.5 py-3">
      <div class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
        <TriangleAlert v-if="!recovery.continuedToRunId" class="size-4" />
        <ShieldCheck v-else class="size-4" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="text-[13px] font-medium text-slate-800">{{ title }}</div>
        <p class="mt-0.5 text-xs leading-5 text-slate-500">
          {{ recovery.reason }}
        </p>
        <div v-if="recovery.recoverable && !recovery.continuedToRunId" class="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="disabled || recovery.resuming"
            @click="emit('continue')"
          >
            <RotateCcw class="size-3.5" :class="recovery.resuming ? 'animate-spin' : ''" />
            {{ recovery.resuming ? '正在创建后续运行' : '继续任务' }}
          </button>
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
            @click="expanded = !expanded"
          >
            恢复详情
            <ChevronDown class="size-3.5 transition-transform" :class="expanded ? 'rotate-180' : ''" />
          </button>
        </div>
      </div>
    </div>
    <div v-if="expanded" class="border-t border-slate-100 bg-slate-50/70 px-3.5 py-2.5 text-xs leading-5 text-slate-500">
      <div class="flex items-center gap-1.5 text-slate-600">
        <ShieldCheck class="size-3.5 text-emerald-600" />
        {{ recovery.checkpointAvailable ? '安全检查点已通过事件前缀校验' : '没有可用检查点，将使用已提交的事件和标准消息上下文' }}
      </div>
      <p class="mt-1">继续会创建新的有限 AgentRun；旧运行保持只读，不会重复应用未确认的文件修改。</p>
    </div>
  </section>
</template>
