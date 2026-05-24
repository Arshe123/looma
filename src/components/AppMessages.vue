<script setup lang="ts">
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/store/workspace'
import { useDownloadsStore, type DownloadTask } from '@/store/downloads'

const workspaceStore = useWorkspaceStore()
const downloadsStore = useDownloadsStore()

const getDownloadTitle = (task: DownloadTask) => {
  if (task.status === 'error') return task.title || '下载失败'
  if (task.status === 'downloading') return task.title || '正在下载'
  return task.title || '下载完成'
}

const getDownloadMessage = (task: DownloadTask) => {
  return task.error || task.message
}

const getDownloadPercent = (task: DownloadTask) => {
  return typeof task.percent === 'number'
    ? Math.min(100, Math.max(0, task.percent))
    : null
}

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}
</script>

<template>
  <div
    v-if="workspaceStore.isBusy"
    class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-panel px-4 py-2 text-xs text-text-main shadow-lg"
  >
    {{ workspaceStore.busyText || '处理中...' }}
  </div>

  <div
    v-if="workspaceStore.isWorkspaceTransitioning"
    class="fixed inset-0 z-40 flex items-center justify-center bg-overlay"
  >
    <div class="w-[420px] max-w-[92vw] rounded-xl border border-border-soft bg-panel p-5 text-center shadow-2xl">
      <div class="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-border-soft border-t-accent"></div>
      <div class="mt-3 text-sm font-semibold text-text-main">Loading</div>
      <div class="mt-1 text-xs text-text-muted">{{ workspaceStore.workspaceTransitionText || '处理中...' }}</div>
    </div>
  </div>

  <div
    v-if="workspaceStore.lastError || downloadsStore.visibleTasks.length"
    class="pointer-events-none fixed bottom-4 left-4 right-4 z-50 flex flex-col items-end gap-3 md:left-auto md:right-4 md:w-[520px]"
  >
    <div
      v-for="task in downloadsStore.visibleTasks"
      :key="task.id"
      class="pointer-events-auto w-full rounded-lg border border-border-soft bg-panel p-4 text-sm text-text-main shadow-2xl md:w-[360px]"
      style="-webkit-app-region: no-drag"
    >
      <div class="mb-3 flex items-start justify-between gap-3">
        <div class="flex min-w-0 items-start gap-2">
          <Loader2
            v-if="task.status === 'downloading'"
            :size="16"
            class="mt-0.5 shrink-0 animate-spin text-accent"
          />
          <AlertCircle
            v-else-if="task.status === 'error'"
            :size="16"
            class="mt-0.5 shrink-0 text-danger"
          />
          <CheckCircle2
            v-else
            :size="16"
            class="mt-0.5 shrink-0 text-success"
          />
          <div class="min-w-0">
            <div class="font-medium">
              {{ getDownloadTitle(task) }}
            </div>
            <p class="mt-1 text-xs leading-5 text-text-muted">
              {{ getDownloadMessage(task) }}
            </p>
          </div>
        </div>
        <button
          v-if="task.status === 'downloading' && task.cancel"
          type="button"
          class="shrink-0 rounded-lg border border-border-soft bg-panel-soft px-2 py-1 text-xs font-medium text-text-main hover:bg-accent-soft"
          @click="downloadsStore.cancelTask(task.id)"
        >
          取消
        </button>
        <button
          v-if="task.status === 'error' && task.retry"
          type="button"
          class="shrink-0 rounded-lg border border-border-soft bg-panel-soft px-2 py-1 text-xs font-medium text-text-main hover:bg-accent-soft"
          @click="downloadsStore.retryTask(task.id)"
        >
          重试
        </button>
        <button
          v-if="task.status !== 'downloading'"
          type="button"
          class="shrink-0 rounded-lg border border-border-soft bg-panel-soft px-2 py-1 text-xs font-medium text-text-main hover:bg-accent-soft"
          @click="downloadsStore.closeTask(task.id)"
        >
          关闭
        </button>
      </div>

      <div class="grid gap-2">
        <div class="h-2 overflow-hidden rounded-full bg-panel-soft">
          <div
            class="h-full rounded-full bg-accent transition-all"
            :class="getDownloadPercent(task) === null ? 'w-1/3 animate-pulse' : ''"
            :style="getDownloadPercent(task) === null ? undefined : { width: `${getDownloadPercent(task)}%` }"
          />
        </div>
        <div class="flex items-center justify-between gap-3 text-[11px] text-text-subtle">
          <span>
            {{ formatBytes(task.receivedBytes) }}
            <template v-if="task.totalBytes">
              / {{ formatBytes(task.totalBytes) }}
            </template>
          </span>
          <span>{{ getDownloadPercent(task) === null ? '计算中' : `${getDownloadPercent(task)}%` }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="workspaceStore.lastError"
      class="pointer-events-auto flex w-full items-center justify-between gap-3 rounded-lg bg-danger px-4 py-3 text-sm text-white shadow-lg"
      style="-webkit-app-region: no-drag"
    >
      <div>{{ workspaceStore.lastError }}</div>
      <button
        class="shrink-0 rounded bg-white/20 px-3 py-1 hover:bg-white/30"
        @click="workspaceStore.clearError()"
      >
        关闭
      </button>
    </div>
  </div>
</template>
