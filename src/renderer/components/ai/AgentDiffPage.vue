<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, FileDiff, Loader2, ShieldCheck, X } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import { useAiAssistantStore } from '@/renderer/stores/ai-assistant'
import {
  buildSideBySideDiffRows,
  getSyncedDiffScrollLeft,
  shouldUseInlineDiff,
} from './agentConversationDisplay'

const workspaceStore = useWorkspaceStore()
const aiStore = useAiAssistantStore()
const actionError = ref('')
const resolvedStatus = ref<'approved' | 'rejected' | null>(null)
const diffRoot = ref<HTMLElement | null>(null)
const beforeScroller = ref<HTMLElement | null>(null)
const afterScroller = ref<HTMLElement | null>(null)
const compactDiff = ref(false)
let resizeObserver: ResizeObserver | null = null
let scrollSyncFrame: number | null = null

const updateDiffMode = (width: number) => {
  compactDiff.value = shouldUseInlineDiff(width)
}

const syncDiffScroll = (source: HTMLElement, target: HTMLElement | null) => {
  if (!target || scrollSyncFrame !== null) return

  target.scrollTop = source.scrollTop
  target.scrollLeft = getSyncedDiffScrollLeft(
    source.scrollLeft,
    source.scrollWidth,
    source.clientWidth,
    target.scrollWidth,
    target.clientWidth,
  )

  scrollSyncFrame = window.requestAnimationFrame(() => {
    scrollSyncFrame = null
  })
}

const handleBeforeScroll = () => {
  if (beforeScroller.value) syncDiffScroll(beforeScroller.value, afterScroller.value)
}

const handleAfterScroll = () => {
  if (afterScroller.value) syncDiffScroll(afterScroller.value, beforeScroller.value)
}

onMounted(() => {
  if (!diffRoot.value) return
  updateDiffMode(diffRoot.value.clientWidth)
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry) updateDiffMode(entry.contentRect.width)
  })
  resizeObserver.observe(diffRoot.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (scrollSyncFrame !== null) window.cancelAnimationFrame(scrollSyncFrame)
})

const view = computed(() => workspaceStore.activeAgentDiff)
const rows = computed(() => buildSideBySideDiffRows(view.value?.diff || ''))
const approval = computed(() => {
  const current = view.value
  if (!current) return undefined
  return aiStore.getPendingFileReview(current.approvalId) || undefined
})
const approvalStatus = computed(() => approval.value?.status || resolvedStatus.value || 'unavailable')
const canResolve = computed(() => approvalStatus.value === 'pending' || approvalStatus.value === 'error')

const resolveApproval = async (approved: boolean) => {
  const current = view.value
  if (!current || !canResolve.value) return
  actionError.value = ''
  const result = await aiStore.resolvePendingFileReview(current.workspaceId, current.approvalId, approved)
  if (!result?.success) actionError.value = result?.error || '提交审批失败，请重试。'
  else resolvedStatus.value = approved ? 'approved' : 'rejected'
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
  <section ref="diffRoot" class="flex h-full min-h-0 flex-col bg-panel text-text-main">
    <header class="flex shrink-0 items-center gap-3 border-b border-border-soft px-4 py-3">
      <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <FileDiff :size="16" />
      </span>
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-sm font-semibold">{{ view?.path || '文件对比' }}</h1>
        <p class="mt-0.5 text-[10px] text-text-muted">
          {{ view?.operation === 'create' ? '新建文件提案' : '文件修改提案' }}
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
      <div v-if="compactDiff" class="min-h-0 flex-1 overflow-auto bg-panel-soft font-mono text-[10px] leading-5">
        <div class="inline-block w-max min-w-full align-top">
          <div
            v-for="row in rows"
            :key="row.id"
            class="grid grid-cols-[44px_minmax(0,1fr)]"
            :class="{
              'border-y border-border-soft bg-accent-soft/40 text-accent': row.kind === 'hunk',
              'bg-red-500/10 text-red-700 dark:text-red-300': row.kind === 'deletion',
              'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300': row.kind === 'addition',
            }"
          >
            <span class="select-none border-r border-border-soft px-2 text-right text-text-subtle">
              {{ row.kind === 'deletion' ? (row.beforeLine || '') : (row.afterLine || '') }}
            </span>
            <span class="whitespace-pre px-3">{{ row.kind === 'deletion' ? (row.before || ' ') : (row.after || ' ') }}</span>
          </div>
        </div>
      </div>

      <div v-else class="grid min-h-0 flex-1 grid-cols-2 bg-panel-soft font-mono text-[10px] leading-5">
        <div
          ref="beforeScroller"
          class="min-w-0 overflow-scroll border-r border-border-soft"
          aria-label="修改前内容"
          @scroll="handleBeforeScroll"
        >
          <div class="inline-block w-max min-w-full align-top">
            <div
              v-for="row in rows"
              :key="row.id"
              class="grid grid-cols-[44px_minmax(0,1fr)]"
              :class="{
                'border-y border-border-soft bg-accent-soft/40 text-accent': row.kind === 'hunk',
                'bg-red-500/10 text-red-700 dark:text-red-300': row.kind === 'deletion',
              }"
            >
              <span class="select-none border-r border-border-soft px-2 text-right text-text-subtle">{{ row.beforeLine || '' }}</span>
              <span class="whitespace-pre px-3">{{ row.before || ' ' }}</span>
            </div>
          </div>
        </div>

        <div
          ref="afterScroller"
          class="min-w-0 overflow-scroll"
          aria-label="修改后内容"
          @scroll="handleAfterScroll"
        >
          <div class="inline-block w-max min-w-full align-top">
            <div
              v-for="row in rows"
              :key="row.id"
              class="grid grid-cols-[44px_minmax(0,1fr)]"
              :class="{
                'border-y border-border-soft bg-accent-soft/40 text-accent': row.kind === 'hunk',
                'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300': row.kind === 'addition',
              }"
            >
              <span class="select-none border-r border-border-soft px-2 text-right text-text-subtle">{{ row.afterLine || '' }}</span>
              <span class="whitespace-pre px-3">{{ row.after || ' ' }}</span>
            </div>
          </div>
        </div>
      </div>

      <p v-if="actionError || approval?.error" class="shrink-0 border-t border-danger/20 bg-danger/10 px-4 py-2 text-[10px] text-danger">
        {{ actionError || approval?.error }}
      </p>

      <footer class="flex shrink-0 items-center justify-between gap-3 border-t border-border-soft px-4 py-3">
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
