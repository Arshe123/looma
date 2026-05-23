<script setup lang="ts">
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/store/workspace'
import { useOllamaStore } from '@/store/ollama'

const workspaceStore = useWorkspaceStore()
const ollamaStore = useOllamaStore()

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
    v-if="workspaceStore.lastError || ollamaStore.showDownloadPanel"
    class="pointer-events-none fixed bottom-4 left-4 right-4 z-50 flex flex-col items-end gap-3 md:left-auto md:right-4 md:w-[520px]"
  >
    <div
      v-if="ollamaStore.showDownloadPanel"
      class="pointer-events-auto w-full rounded-lg border border-border-soft bg-panel p-4 text-sm text-text-main shadow-2xl md:w-[360px]"
      style="-webkit-app-region: no-drag"
    >
      <div class="mb-3 flex items-start justify-between gap-3">
        <div class="flex min-w-0 items-start gap-2">
          <Loader2
            v-if="ollamaStore.isDownloading"
            :size="16"
            class="mt-0.5 shrink-0 animate-spin text-accent"
          />
          <AlertCircle
            v-else-if="ollamaStore.downloadError"
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
              {{ ollamaStore.downloadError ? 'Ollama 下载失败' : (ollamaStore.isDownloading ? '正在下载 Ollama' : 'Ollama 安装器已打开') }}
            </div>
            <p class="mt-1 text-xs leading-5 text-text-muted">
              {{ ollamaStore.downloadError || ollamaStore.downloadMessage }}
            </p>
          </div>
        </div>
        <button
          v-if="ollamaStore.downloadError"
          type="button"
          class="shrink-0 rounded-lg border border-border-soft bg-panel-soft px-2 py-1 text-xs font-medium text-text-main hover:bg-accent-soft"
          @click="ollamaStore.retryDownload()"
        >
          重试
        </button>
      </div>

      <div class="grid gap-2">
        <div class="h-2 overflow-hidden rounded-full bg-panel-soft">
          <div
            class="h-full rounded-full bg-accent transition-all"
            :class="ollamaStore.downloadPercent === null ? 'w-1/3 animate-pulse' : ''"
            :style="ollamaStore.downloadPercent === null ? undefined : { width: `${ollamaStore.downloadPercent}%` }"
          />
        </div>
        <div class="flex items-center justify-between gap-3 text-[11px] text-text-subtle">
          <span>
            {{ formatBytes(ollamaStore.downloadProgress.receivedBytes) }}
            <template v-if="ollamaStore.downloadProgress.totalBytes">
              / {{ formatBytes(ollamaStore.downloadProgress.totalBytes) }}
            </template>
          </span>
          <span>{{ ollamaStore.downloadPercent === null ? '计算中' : `${ollamaStore.downloadPercent}%` }}</span>
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
