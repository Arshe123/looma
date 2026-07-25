<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, ChevronDown, FileDiff, Files, Loader2, X } from 'lucide-vue-next'
import { useAiAssistantStore, type PendingFileReviewState } from '@/renderer/stores/ai-assistant'
import { useWorkspaceStore } from '@/renderer/stores/workspace'

const props = defineProps<{
  workspaceId: string
  conversationId: string
}>()

const aiStore = useAiAssistantStore()
const workspaceStore = useWorkspaceStore()
const expanded = ref(false)
const batchAction = ref<'approve' | 'reject' | null>(null)
const actionError = ref('')

const reviews = computed(() => aiStore.getWorkspacePendingFileReviews(props.workspaceId))
const additions = computed(() => reviews.value.reduce((total, item) => total + item.additions, 0))
const deletions = computed(() => reviews.value.reduce((total, item) => total + item.deletions, 0))
const hasResolvingItem = computed(() => reviews.value.some(item => item.status === 'resolving'))

const fileName = (path: string) => path.split('/').filter(Boolean).at(-1) || path

const openReview = (review: PendingFileReviewState) => {
  workspaceStore.openAgentDiffPage({
    workspaceId: props.workspaceId,
    conversationId: props.conversationId,
    approvalId: review.approvalId,
    path: review.path,
    operation: review.operation,
    diff: review.diff,
    additions: review.additions,
    deletions: review.deletions,
  })
}

const resolveAll = async (approved: boolean) => {
  if (!reviews.value.length || batchAction.value) return
  actionError.value = ''
  batchAction.value = approved ? 'approve' : 'reject'
  const result = await aiStore.resolveAllPendingFileReviews(props.workspaceId, approved)
  batchAction.value = null
  if (!result.success) {
    actionError.value = result.error || '批量处理失败，请重试。'
    if (!reviews.value.length) {
      workspaceStore.appendAiAssistantMessageToConversation(
        props.conversationId,
        'system',
        `文件批量审查已完成，但存在异常：${actionError.value}`,
      )
    }
  }
  if (!reviews.value.length) expanded.value = false
}
</script>

<template>
  <section
    v-if="reviews.length"
    class="absolute inset-x-3 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border-soft bg-panel shadow-lg shadow-black/10"
    aria-label="待审查文件"
  >
    <div v-if="expanded" class="max-h-[min(42vh,320px)] overflow-y-auto border-b border-border-soft bg-panel-soft/50">
      <button
        v-for="review in reviews"
        :key="review.approvalId"
        type="button"
        class="flex w-full items-center gap-2.5 border-b border-border-soft px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent-soft/50 disabled:cursor-wait"
        :disabled="review.status === 'resolving'"
        @click="openReview(review)"
      >
        <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-panel text-accent">
          <Loader2 v-if="review.status === 'resolving'" :size="13" class="animate-spin" />
          <FileDiff v-else :size="13" />
        </span>
        <span class="min-w-0 flex-1">
          <strong class="block truncate text-[11px] font-medium text-text-main">{{ fileName(review.path) }}</strong>
          <small class="mt-0.5 block truncate text-[9px] text-text-subtle">{{ review.path }}</small>
          <small v-if="review.error" class="mt-0.5 block truncate text-[9px] text-danger">{{ review.error }}</small>
        </span>
        <span class="shrink-0 text-[10px] font-medium text-success">+{{ review.additions }}</span>
        <span class="shrink-0 text-[10px] font-medium text-danger">−{{ review.deletions }}</span>
        <span class="shrink-0 text-text-subtle">›</span>
      </button>
    </div>

    <p v-if="actionError" class="border-b border-danger/20 bg-danger/10 px-3 py-1.5 text-[10px] text-danger">
      {{ actionError }}
    </p>

    <div class="flex h-10 items-center gap-2 px-2.5">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Files :size="13" />
        </span>
        <strong class="truncate text-[11px] font-semibold text-text-main">{{ reviews.length }} 个文件待审查</strong>
      </div>
      <span class="shrink-0 text-[10px] font-semibold text-success">+{{ additions }}</span>
      <span class="shrink-0 text-[10px] font-semibold text-danger">−{{ deletions }}</span>
      <span class="mx-0.5 h-4 w-px bg-border-soft" />
      <button
        type="button"
        class="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-success px-2 text-[10px] font-medium text-white transition-colors hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
        :disabled="Boolean(batchAction) || hasResolvingItem"
        @click="resolveAll(true)"
      >
        <Loader2 v-if="batchAction === 'approve'" :size="11" class="animate-spin" />
        <Check v-else :size="11" />
        全部接受
      </button>
      <button
        type="button"
        class="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border-soft px-2 text-[10px] font-medium text-text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-wait disabled:opacity-50"
        :disabled="Boolean(batchAction) || hasResolvingItem"
        @click="resolveAll(false)"
      >
        <Loader2 v-if="batchAction === 'reject'" :size="11" class="animate-spin" />
        <X v-else :size="11" />
        全部拒绝
      </button>
      <button
        type="button"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-panel-soft hover:text-text-main"
        :aria-label="expanded ? '收起文件审查' : '展开文件审查'"
        :title="expanded ? '收起' : '展开'"
        @click="expanded = !expanded"
      >
        <ChevronDown :size="14" class="transition-transform" :class="expanded ? '' : 'rotate-180'" />
      </button>
    </div>
  </section>
</template>
