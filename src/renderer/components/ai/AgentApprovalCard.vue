<script setup lang="ts">
import { Check, FileDiff, Loader2, ShieldCheck, X } from 'lucide-vue-next'
import type { AgentApprovalState } from '@/renderer/stores/ai-assistant'

defineProps<{ approval: AgentApprovalState }>()
const emit = defineEmits<{
  resolve: [approvalId: string, approved: boolean]
}>()

const lineClass = (line: string) => {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  if (line.startsWith('-') && !line.startsWith('---')) return 'bg-red-500/10 text-red-700 dark:text-red-300'
  if (line.startsWith('@@')) return 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
  return 'text-text-muted'
}
</script>

<template>
  <section class="relative z-10 overflow-hidden rounded-lg border border-amber-500/30 bg-panel shadow-sm">
    <header class="flex items-start gap-2.5 border-b border-border-soft bg-amber-500/[0.07] px-3 py-2.5">
      <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-300">
        <FileDiff :size="15" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <h3 class="truncate text-[11px] font-semibold text-text-main">需要审批 · {{ approval.path }}</h3>
          <span class="shrink-0 rounded-full border border-border-soft bg-panel px-1.5 py-0.5 text-[8px] uppercase text-text-muted">{{ approval.operation }}</span>
        </div>
        <p class="mt-1 text-[9px] leading-4 text-text-muted">Agent 已暂停。批准后由 Electron 主进程复验路径与文件 hash，再原子写入。</p>
      </div>
    </header>

    <div class="max-h-56 overflow-auto bg-canvas py-1 font-mono text-[9px] leading-[1.55]">
      <div
        v-for="(line, index) in approval.diff.split('\n')"
        :key="index"
        class="min-w-max whitespace-pre px-3"
        :class="lineClass(line)"
      >{{ line || ' ' }}</div>
    </div>

    <p v-if="approval.error" class="border-t border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[9px] leading-4 text-red-600 dark:text-red-300">
      {{ approval.error }}
    </p>

    <footer class="flex items-center justify-between gap-2 border-t border-border-soft px-3 py-2.5">
      <span class="inline-flex items-center gap-1 text-[9px] text-text-muted">
        <ShieldCheck :size="12" class="text-emerald-500" />
        未批准不会写入
      </span>
      <div v-if="approval.status === 'pending' || approval.status === 'error'" class="flex gap-1.5">
        <button class="inline-flex h-7 items-center gap-1 rounded-md border border-border-soft px-2.5 text-[10px] text-text-muted hover:bg-panel-soft" type="button" @click="emit('resolve', approval.approvalId, false)">
          <X :size="12" />拒绝
        </button>
        <button class="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[10px] font-medium text-white hover:bg-accent-hover" type="button" @click="emit('resolve', approval.approvalId, true)">
          <Check :size="12" />批准并应用
        </button>
      </div>
      <span v-else-if="approval.status === 'resolving'" class="inline-flex items-center gap-1 text-[10px] text-text-muted"><Loader2 :size="12" class="animate-spin" />正在安全应用...</span>
      <span v-else class="text-[10px] text-text-muted">{{ approval.status }}</span>
    </footer>
  </section>
</template>
