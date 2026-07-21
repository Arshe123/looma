<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, FileDiff, Loader2, ShieldCheck, X } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import { useAiAssistantStore } from '@/renderer/stores/ai-assistant'
import { buildSideBySideDiffRows } from './agentConversationDisplay'

const workspaceStore = useWorkspaceStore()
const aiStore = useAiAssistantStore()
const actionError = ref('')

const view = computed(() => workspaceStore.activeAgentDiff)
const rows = computed(() => buildSideBySideDiffRows(view.value?.diff || ''))
const approval = computed(() => {
  const current = view.value
  if (!current) return undefined
  return aiStore.getConversationAgentApprovals(current.conversationId)
    .find((item) => item.approvalId === current.approvalId)
})
const approvalStatus = computed(() => approval.value?.status || 'unavailable')
const canResolve = computed(() => approvalStatus.value === 'pending' || approvalStatus.value === 'error')

const resolveApproval = async (approved: boolean) => {
  const current = view.value
  if (!current || !canResolve.value) return
  actionError.value = ''
  const result = await aiStore.resolveAgentApproval(current.conversationId, current.approvalId, approved)
  if (!result?.success) actionError.value = result?.error || '提交审批失败，请重试。'
}

const statusLabel = computed(() => ({
  pending: '等待审批',
  resolving: '正在安全应用',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已过期',
  cancelled: '已取消',
  error: '审批失败',
  unavailable: '只读记录',
}[approvalStatus.value] || approvalStatus.value))
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-panel text-text-main">
    <header class="flex shrink-0 items-center gap-3 border-b border-border-soft px-4 py-3">
      <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <FileDiff :size="16" />
      </span>
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-sm font-semibold">{{ view?.path || '文件对比' }}</h1>
        <p class="mt-0.5 text-[10px] text-text-muted">
          {{ view?.operation === 'create' ? '新建文件提案' : '文件修改提案' }} · Electron 主进程将在批准后重新校验路径与文件 hash
        </p>
      </div>
      <span v-if="view" class="text-[10px] text-success">+{{ view.additions }}</span>
      <span v-if="view" class="text-[10px] text-danger">−{{ view.deletions }}</span>
      <span class="rounded-full border border-border-soft bg-panel-soft px-2 py-1 text-[9px] text-text-muted">{{ statusLabel }}</span>
    </header>

    <div v-if="!view" class="flex flex-1 items-center justify-center p-8 text-center text-sm text-text-muted">
      当前 Diff 数据只在本次运行中保留，请从 Agent 对话中的文件卡片重新打开。
    </div>

    <template v-else>
      <div class="grid shrink-0 grid-cols-2 border-b border-border-soft bg-panel-soft text-[10px] font-medium text-text-muted">
        <div class="border-r border-border-soft px-4 py-2">修改前</div>
        <div class="px-4 py-2">修改后</div>
      </div>

      <div class="min-h-0 flex-1 overflow-auto bg-panel-soft font-mono text-[10px] leading-5">
        <div
          v-for="row in rows"
          :key="row.id"
          class="grid min-w-[760px] grid-cols-2"
          :class="row.kind === 'hunk' ? 'border-y border-border-soft bg-accent-soft/40 text-accent' : ''"
        >
          <div
            class="grid grid-cols-[44px_minmax(0,1fr)] border-r border-border-soft"
            :class="row.kind === 'deletion' ? 'bg-red-500/10 text-red-700 dark:text-red-300' : ''"
          >
            <span class="select-none border-r border-border-soft px-2 text-right text-text-subtle">{{ row.beforeLine || '' }}</span>
            <span class="whitespace-pre px-3">{{ row.before || ' ' }}</span>
          </div>
          <div
            class="grid grid-cols-[44px_minmax(0,1fr)]"
            :class="row.kind === 'addition' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : ''"
          >
            <span class="select-none border-r border-border-soft px-2 text-right text-text-subtle">{{ row.afterLine || '' }}</span>
            <span class="whitespace-pre px-3">{{ row.after || ' ' }}</span>
          </div>
        </div>
      </div>

      <p v-if="actionError || approval?.error" class="shrink-0 border-t border-danger/20 bg-danger/10 px-4 py-2 text-[10px] text-danger">
        {{ actionError || approval?.error }}
      </p>

      <footer class="flex shrink-0 items-center justify-between gap-3 border-t border-border-soft px-4 py-3">
        <span class="inline-flex items-center gap-1.5 text-[10px] text-text-muted">
          <ShieldCheck :size="13" class="text-success" />
          未批准不会写入；此页面本身没有文件写入能力
        </span>
        <div v-if="canResolve" class="flex items-center gap-2">
          <button type="button" class="inline-flex h-8 items-center gap-1 rounded-md border border-border-soft px-3 text-[10px] text-text-muted hover:bg-panel-soft" @click="resolveApproval(false)">
            <X :size="12" />拒绝
          </button>
          <button type="button" class="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-[10px] font-medium text-white hover:bg-accent-hover" @click="resolveApproval(true)">
            <Check :size="12" />批准并应用
          </button>
        </div>
        <span v-else-if="approvalStatus === 'resolving'" class="inline-flex items-center gap-1.5 text-[10px] text-text-muted">
          <Loader2 :size="12" class="animate-spin" />正在安全应用...
        </span>
      </footer>
    </template>
  </section>
</template>
