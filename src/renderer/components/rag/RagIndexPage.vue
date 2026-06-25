<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlertTriangle, CheckCircle2, Database, FileText, Loader2, RefreshCw, RotateCcw, Search, Settings, Trash2, XCircle } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import RagIndexSettingsDialog from './RagIndexSettingsDialog.vue'

type IndexStatus = 'indexed' | 'not_indexed' | 'outdated' | 'deleted' | 'failed' | 'ignored'
type BuildMode = 'incremental' | 'full' | 'retry_failed'

type IndexFile = {
  path: string
  status: IndexStatus
  chunkCount?: number
  lastIndexedAt?: string | null
  size?: number
  error?: string | null
}

type FileChunk = {
  id: string
  index: number
  text: string
  textLength?: number
  metadata: Record<string, unknown>
  filePath?: string
}

type IndexSummary = {
  indexed: number
  notIndexed: number
  outdated: number
  deleted: number
  failed: number
  ignored: number
}

type IndexMetadata = {
  indexVersion?: number
  workspaceId?: string
  createdAt?: string
  updatedAt?: string
  embedding?: {
    provider?: string
    model?: string
    dimension?: number | null
  }
  chunking?: {
    chunkSize?: number
    chunkOverlap?: number
  }
  parser?: {
    type?: string
    version?: number
  }
  lastBuild?: {
    indexedAt?: string
    documentCount?: number
    fileCount?: number
    chunkCount?: number
    status?: string
    embeddingProvider?: string
    embeddingModel?: string
    chunkSize?: number
    chunkOverlap?: number
    parserType?: string
    parserVersion?: number
  }
}

type IndexStatusPayload = {
  exists: boolean
  persist_dir?: string
  indexCompatible?: boolean
  needRebuild?: boolean
  compatibility?: { compatible: boolean; needRebuild: boolean; reason: string }
  summary?: IndexSummary
  files?: IndexFile[]
  metadata?: IndexMetadata | null
  error?: string
}

const workspaceStore = useWorkspaceStore()
const showSettings = ref(false)
const status = ref<IndexStatusPayload | null>(null)
const isLoading = ref(false)
const isBuilding = ref(false)
const activeRequestId = ref('')
const buildMode = ref<BuildMode | ''>('')
const errorText = ref('')
const searchQuery = ref('')
const statusFilter = ref<'all' | IndexStatus>('all')
const filePage = ref(1)
const filePageSize = ref(20)
const filePageSizeOptions = [10, 20, 50, 100]
const buildLog = ref<string[]>([])
const selectedFile = ref<IndexFile | null>(null)
const fileChunks = ref<FileChunk[]>([])
const isLoadingChunks = ref(false)
const chunkError = ref('')
const chunkSearchQuery = ref('')
const reindexingFilePath = ref('')
const reindexStartedAt = ref<number | null>(null)
const reindexElapsedSeconds = ref(0)
const reindexMessage = ref('')
const reindexError = ref('')
const reindexSuccessPath = ref('')
let unsubscribeIndexStream: (() => void) | null = null
let reindexTimer: number | null = null

const activeWorkspaceId = computed(() => workspaceStore.activeWorkspaceId)
const activeWorkspaceName = computed(() => workspaceStore.activeWorkspace?.name || '当前工作空间')
const summary = computed<IndexSummary>(() => status.value?.summary ?? {
  indexed: 0,
  notIndexed: 0,
  outdated: 0,
  deleted: 0,
  failed: 0,
  ignored: 0,
})
const totalActionable = computed(() => summary.value.notIndexed + summary.value.outdated + summary.value.deleted + summary.value.failed)
const isFileReindexing = computed(() => Boolean(reindexingFilePath.value))
const activeReindexFile = computed(() =>
  (status.value?.files ?? []).find((file) => file.path === reindexingFilePath.value) ?? null,
)
const reindexElapsedLabel = computed(() => `${Math.max(0, reindexElapsedSeconds.value)}s`)
const indexMetadata = computed(() => status.value?.metadata ?? null)
const lastBuild = computed(() => indexMetadata.value?.lastBuild ?? null)
const metadataEmbeddingLabel = computed(() => {
  const embedding = indexMetadata.value?.embedding
  const provider = embedding?.provider || lastBuild.value?.embeddingProvider || '—'
  const model = embedding?.model || lastBuild.value?.embeddingModel || '—'
  return `${provider} · ${model}`
})
const metadataChunkingLabel = computed(() => {
  const chunking = indexMetadata.value?.chunking
  const size = chunking?.chunkSize ?? lastBuild.value?.chunkSize
  const overlap = chunking?.chunkOverlap ?? lastBuild.value?.chunkOverlap
  if (size === undefined && overlap === undefined) return '—'
  return `${size ?? '—'} / ${overlap ?? '—'}`
})
const healthLabel = computed(() => {
  if (!status.value) return '未检查'
  if (status.value.needRebuild) return '需要重建'
  if (summary.value.failed > 0) return '存在失败'
  if (summary.value.notIndexed + summary.value.outdated + summary.value.deleted > 0) return '需要同步'
  if (status.value.exists) return '索引正常'
  return '未建立索引'
})
const healthClass = computed(() => {
  if (!status.value || status.value.needRebuild || !status.value.exists) return 'border-amber-300/60 bg-amber-50 text-amber-700'
  if (summary.value.failed > 0) return 'border-danger/30 bg-danger/10 text-danger'
  if (totalActionable.value > 0) return 'border-blue-300/60 bg-blue-50 text-blue-700'
  return 'border-success/30 bg-success/10 text-success'
})
const filteredFiles = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return (status.value?.files ?? [])
    .filter((file) => statusFilter.value === 'all' || file.status === statusFilter.value)
    .filter((file) => !q || file.path.toLowerCase().includes(q))
})
const totalFilteredFiles = computed(() => filteredFiles.value.length)
const fileTotalPages = computed(() => Math.max(1, Math.ceil(totalFilteredFiles.value / filePageSize.value)))
const filePageStart = computed(() => totalFilteredFiles.value === 0 ? 0 : (filePage.value - 1) * filePageSize.value + 1)
const filePageEnd = computed(() => Math.min(totalFilteredFiles.value, filePage.value * filePageSize.value))
const paginatedFiles = computed(() => {
  const start = (filePage.value - 1) * filePageSize.value
  return filteredFiles.value.slice(start, start + filePageSize.value)
})
const filePageNumbers = computed(() => {
  const total = fileTotalPages.value
  const current = filePage.value
  const start = Math.max(1, Math.min(current - 2, total - 4))
  const end = Math.min(total, start + 4)
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
})
const filteredChunks = computed(() => {
  const q = chunkSearchQuery.value.trim().toLowerCase()
  if (!q) return fileChunks.value
  return fileChunks.value.filter((chunk) =>
    chunk.text.toLowerCase().includes(q)
    || chunk.id.toLowerCase().includes(q)
    || JSON.stringify(chunk.metadata || {}).toLowerCase().includes(q),
  )
})

const statusLabels: Record<IndexStatus, string> = {
  indexed: '已索引',
  not_indexed: '未索引',
  outdated: '已过期',
  deleted: '待清理',
  failed: '失败',
  ignored: '已忽略',
}

const statusClasses: Record<IndexStatus, string> = {
  indexed: 'bg-success/10 text-success border-success/20',
  not_indexed: 'bg-blue-50 text-blue-700 border-blue-200',
  outdated: 'bg-amber-50 text-amber-700 border-amber-200',
  deleted: 'bg-zinc-100 text-zinc-600 border-zinc-200',
  failed: 'bg-danger/10 text-danger border-danger/20',
  ignored: 'bg-panel-soft text-text-subtle border-border-soft',
}

const makeRequestId = () => `${Date.now()}:${Math.random().toString(36).slice(2)}`

const goToFilePage = (page: number) => {
  filePage.value = Math.min(Math.max(1, page), fileTotalPages.value)
}

const handleFilePageSizeChange = (event: Event) => {
  const value = Number((event.target as HTMLSelectElement).value)
  filePageSize.value = Number.isFinite(value) && value > 0 ? value : 20
  filePage.value = 1
}

const stopReindexTimer = () => {
  if (reindexTimer !== null) {
    window.clearInterval(reindexTimer)
    reindexTimer = null
  }
}

const startReindexTimer = () => {
  stopReindexTimer()
  reindexStartedAt.value = Date.now()
  reindexElapsedSeconds.value = 0
  reindexTimer = window.setInterval(() => {
    if (!reindexStartedAt.value) return
    reindexElapsedSeconds.value = Math.max(0, Math.floor((Date.now() - reindexStartedAt.value) / 1000))
  }, 500)
}

const clearReindexFeedbackLater = (path: string) => {
  window.setTimeout(() => {
    if (reindexSuccessPath.value === path && !reindexingFilePath.value) {
      reindexSuccessPath.value = ''
      reindexMessage.value = ''
    }
  }, 2400)
}

const formatFileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path

const formatFileSize = (size?: number) => {
  if (!Number.isFinite(size)) return '—'
  const value = size as number
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

const formatTime = (value?: string | null) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

const refreshStatus = async () => {
  const workspaceId = activeWorkspaceId.value
  if (!workspaceId) return
  isLoading.value = true
  errorText.value = ''
  try {
    const result = await window.electronAPI.rag.status(workspaceId)
    if (!result.success) {
      errorText.value = result.error || '读取索引状态失败。'
      return
    }
    status.value = result.data as IndexStatusPayload
  } catch (error: any) {
    errorText.value = error?.message ?? String(error)
  } finally {
    isLoading.value = false
  }
}

const cancelBuild = async () => {
  if (!activeRequestId.value) return
  await window.electronAPI.rag.indexStream.cancel(activeRequestId.value).catch(() => {})
  activeRequestId.value = ''
  buildMode.value = ''
  isBuilding.value = false
}

const buildIndex = async (mode: BuildMode) => {
  const workspaceId = activeWorkspaceId.value
  if (!workspaceId || isBuilding.value) return
  if (mode === 'full') {
    const ok = window.confirm('全量重建会清空旧索引并重新生成，确认继续？')
    if (!ok) return
  }
  errorText.value = ''
  buildLog.value = []
  isBuilding.value = true
  buildMode.value = mode
  activeRequestId.value = makeRequestId()
  const result = await window.electronAPI.rag.indexStream.start(activeRequestId.value, workspaceId, mode)
  if (!result.success) {
    errorText.value = result.error || '启动索引任务失败。'
    isBuilding.value = false
    buildMode.value = ''
    activeRequestId.value = ''
  }
}

const reindexFile = async (path: string) => {
  const workspaceId = activeWorkspaceId.value
  if (!workspaceId || isBuilding.value || isFileReindexing.value) return

  errorText.value = ''
  reindexError.value = ''
  reindexSuccessPath.value = ''
  reindexingFilePath.value = path
  reindexMessage.value = `正在重建 ${formatFileName(path)} 的索引...`
  startReindexTimer()

  try {
    const result = await window.electronAPI.rag.indexFile.reindex(workspaceId, path)
    if (!result.success) {
      reindexError.value = result.error || `重建 ${path} 索引失败。`
      errorText.value = reindexError.value
      return
    }
    if (result.data?.error) {
      reindexError.value = result.data.error
      errorText.value = result.data.error
      return
    }

    const chunks = (result.data as any)?.chunks ?? result.data?.document_count ?? 0
    reindexSuccessPath.value = path
    reindexMessage.value = `已完成 ${formatFileName(path)} 的索引重建，生成 ${chunks} 个 chunk。`
    await refreshStatus()
    if (selectedFile.value?.path === path) {
      const latest = (status.value?.files ?? []).find((file) => file.path === path)
      if (latest) {
        selectedFile.value = latest
        await openFileChunks(latest)
      } else if (selectedFile.value) {
        await openFileChunks(selectedFile.value)
      }
    }
    clearReindexFeedbackLater(path)
  } catch (error: any) {
    reindexError.value = error?.message ?? String(error)
    errorText.value = reindexError.value
  } finally {
    stopReindexTimer()
    reindexStartedAt.value = null
    reindexingFilePath.value = ''
  }
}

const closeChunkDrawer = () => {
  selectedFile.value = null
  fileChunks.value = []
  chunkError.value = ''
  chunkSearchQuery.value = ''
  isLoadingChunks.value = false
}

const openFileChunks = async (file: IndexFile) => {
  const workspaceId = activeWorkspaceId.value
  if (!workspaceId || file.status === 'ignored') return
  selectedFile.value = file
  fileChunks.value = []
  chunkError.value = ''
  chunkSearchQuery.value = ''
  isLoadingChunks.value = true
  try {
    const result = await window.electronAPI.rag.indexFile.chunks(workspaceId, file.path)
    if (!result.success) {
      chunkError.value = result.error || '读取 chunk 详情失败。'
      return
    }
    if (result.data?.error) {
      chunkError.value = result.data.error
    }
    fileChunks.value = (result.data?.chunks ?? []) as FileChunk[]
    if (result.data?.requiresRebuild && fileChunks.value.length === 0) {
      chunkError.value = '当前索引缺少按文件追踪信息，请全量重建索引后再查看 chunk 详情。'
    }
  } catch (error: any) {
    chunkError.value = error?.message ?? String(error)
  } finally {
    isLoadingChunks.value = false
  }
}

const copyChunkText = async (chunk: FileChunk) => {
  try {
    await navigator.clipboard.writeText(chunk.text || '')
  } catch (error) {
    chunkError.value = '复制失败，请检查剪贴板权限。'
  }
}


const deleteAllIndex = async () => {
  const workspaceId = activeWorkspaceId.value
  if (!workspaceId || isBuilding.value) return
  const ok = window.confirm('确认删除当前工作空间的全部索引数据？\n\n此操作不可恢复。')
  if (!ok) return
  errorText.value = ''
  try {
    const result = await window.electronAPI.rag.deleteIndex(workspaceId)
    if (!result.success) {
      errorText.value = result.error || '删除索引失败。'
      return
    }
    await refreshStatus()
  } catch (error: any) {
    errorText.value = error?.message ?? String(error)
  }
}

const deleteFileIndex = async (path: string) => {
  const workspaceId = activeWorkspaceId.value
  if (!workspaceId || isBuilding.value) return
  const ok = window.confirm(`删除索引记录：${path}？`)
  if (!ok) return
  const result = await window.electronAPI.rag.indexFile.delete(workspaceId, path)
  if (!result.success) {
    errorText.value = result.error || `删除 ${path} 索引失败。`
    return
  }
  await refreshStatus()
}

const handleIndexStreamEvent = (payload: Parameters<Parameters<typeof window.electronAPI.rag.indexStream.onEvent>[0]>[0]) => {
  if (!activeRequestId.value || payload.requestId !== activeRequestId.value) return
  if (payload.type === 'timeline') {
    const title = payload.title || payload.stepId || '索引任务'
    const detail = payload.detail || payload.status || ''
    buildLog.value.unshift(`${title}${detail ? `：${detail}` : ''}`)
    return
  }
  if (payload.type === 'progress') {
    buildLog.value.unshift(payload.message || `${payload.current}/${payload.total ?? '?'}`)
    return
  }
  if (payload.type === 'done') {
    buildLog.value.unshift('索引任务完成。')
    isBuilding.value = false
    buildMode.value = ''
    activeRequestId.value = ''
    refreshStatus().catch(() => {})
    return
  }
  if (payload.type === 'error') {
    errorText.value = payload.error || '索引任务失败。'
    isBuilding.value = false
    buildMode.value = ''
    activeRequestId.value = ''
  }
}

onMounted(() => {
  unsubscribeIndexStream = window.electronAPI.rag.indexStream.onEvent(handleIndexStreamEvent)
  refreshStatus().catch(() => {})
})

watch([searchQuery, statusFilter], () => {
  filePage.value = 1
})

watch(fileTotalPages, (total) => {
  if (filePage.value > total) filePage.value = total
})

onBeforeUnmount(() => {
  cancelBuild().catch(() => {})
  stopReindexTimer()
  unsubscribeIndexStream?.()
  unsubscribeIndexStream = null
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-panel text-text-main">
    <header class="shrink-0 border-b border-border-soft px-5 py-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-subtle">RAG Index Library</div>
          <h1 class="mt-1 text-xl font-bold tracking-[-0.03em] text-text-main">索引库</h1>
          <p class="mt-1 text-sm text-text-muted">管理 {{ activeWorkspaceName }} 的本地 RAG 索引、文件状态和配置兼容性。</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button class="inline-flex h-9 items-center gap-2 rounded-xl border border-border-soft bg-panel-soft px-3 text-xs font-medium hover:bg-accent-soft disabled:cursor-not-allowed disabled:text-text-subtle" :disabled="isLoading || isBuilding || isFileReindexing" @click="refreshStatus">
            <Loader2 v-if="isLoading" :size="14" class="animate-spin" />
            <RefreshCw v-else :size="14" />
            刷新状态
          </button>
          <button class="inline-flex h-9 items-center gap-2 rounded-xl bg-accent px-3 text-xs font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-accent-soft disabled:text-text-muted" :disabled="isBuilding || isFileReindexing" @click="buildIndex('incremental')">
            <Loader2 v-if="isBuilding && buildMode === 'incremental'" :size="14" class="animate-spin" />
            <Database v-else :size="14" />
            增量更新
          </button>
          <button class="inline-flex h-9 items-center gap-2 rounded-xl border border-border-soft bg-panel-soft px-3 text-xs font-medium hover:bg-accent-soft disabled:cursor-not-allowed disabled:text-text-subtle" :disabled="isBuilding || isFileReindexing" @click="buildIndex('retry_failed')">
            <RotateCcw :size="14" />
            重试失败
          </button>
          <button class="inline-flex h-9 items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 text-xs font-medium text-danger hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-60" :disabled="isBuilding || isFileReindexing" @click="buildIndex('full')">
            <Trash2 :size="14" />
            全量重建
          </button>
          <button class="inline-flex h-9 items-center gap-2 rounded-xl border border-danger/20 bg-panel-soft px-3 text-xs font-medium text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50" :disabled="isBuilding || isFileReindexing" @click="deleteAllIndex">
            <Trash2 :size="14" />
            删除全部索引
          </button>
          <button class="inline-flex h-9 items-center gap-2 rounded-xl border border-border-soft bg-panel-soft px-3 text-xs font-medium hover:bg-accent-soft" :class="{ 'bg-accent-soft text-accent': showSettings }" @click="showSettings = true">
            <Settings :size="14" />
            设置
          </button>
        </div>
      </div>
    </header>

    <RagIndexSettingsDialog
      :open="showSettings"
      :disabled="isBuilding || isFileReindexing"
      @close="showSettings = false"
      @saved="refreshStatus"
      @save-and-rebuild="buildIndex('full')"
    />

    <main class="min-h-0 flex-1 overflow-y-auto p-5">
      <div v-if="errorText" class="mb-4 rounded-2xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
        {{ errorText }}
      </div>

      <section
        v-if="isFileReindexing || reindexMessage || reindexError"
        class="mb-4 overflow-hidden rounded-2xl border p-4"
        :class="reindexError
          ? 'border-danger/30 bg-danger/10 text-danger'
          : isFileReindexing
            ? 'border-accent/30 bg-accent-soft/70 text-text-main'
            : 'border-success/30 bg-success/10 text-success'"
      >
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="flex min-w-0 items-start gap-3">
            <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-panel shadow-sm">
              <Loader2 v-if="isFileReindexing" :size="16" class="animate-spin text-accent" />
              <CheckCircle2 v-else-if="!reindexError" :size="16" class="text-success" />
              <AlertTriangle v-else :size="16" class="text-danger" />
            </span>
            <div class="min-w-0">
              <h2 class="text-sm font-semibold">
                {{ isFileReindexing ? '正在重建单文件索引' : reindexError ? '单文件重建失败' : '单文件重建完成' }}
              </h2>
              <p class="mt-1 truncate text-xs" :class="reindexError ? 'text-danger' : 'text-text-muted'">
                {{ reindexError || reindexMessage }}
              </p>
              <div v-if="isFileReindexing" class="mt-3 h-1.5 overflow-hidden rounded-full bg-panel">
                <div class="h-full w-1/3 animate-pulse rounded-full bg-accent" />
              </div>
              <div v-if="isFileReindexing && activeReindexFile" class="mt-2 flex flex-wrap gap-2 text-[11px] text-text-muted">
                <span class="rounded-full border border-border-soft bg-panel px-2 py-0.5">{{ activeReindexFile.status ? statusLabels[activeReindexFile.status] : '待处理' }}</span>
                <span class="rounded-full border border-border-soft bg-panel px-2 py-0.5">原 Chunks：{{ activeReindexFile.chunkCount ?? 0 }}</span>
                <span class="rounded-full border border-border-soft bg-panel px-2 py-0.5">大小：{{ formatFileSize(activeReindexFile.size) }}</span>
              </div>
            </div>
          </div>
          <span v-if="isFileReindexing" class="shrink-0 rounded-full border border-accent/20 bg-panel px-3 py-1 text-xs font-medium text-accent">
            已耗时 {{ reindexElapsedLabel }}
          </span>
        </div>
      </section>

      <section class="grid gap-4 lg:grid-cols-[1.2fr_2fr]">
        <div class="rounded-2xl border border-border-soft bg-panel-soft p-4">
          <div class="mb-3 flex items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-panel text-accent"><Database :size="18" /></span>
              <div>
                <h2 class="text-sm font-semibold">索引健康状态</h2>
                <p class="text-xs text-text-muted">{{ status?.persist_dir || '尚未读取索引目录' }}</p>
              </div>
            </div>
            <span class="rounded-full border px-3 py-1 text-xs font-medium" :class="healthClass">{{ healthLabel }}</span>
          </div>
          <div class="rounded-xl border border-border-soft bg-panel p-3 text-xs leading-5 text-text-muted">
            <div class="mb-1 flex items-center gap-2 font-medium text-text-main">
              <CheckCircle2 v-if="status?.indexCompatible && !status?.needRebuild" :size="14" class="text-success" />
              <AlertTriangle v-else :size="14" class="text-amber-600" />
              配置兼容性
            </div>
            {{ status?.compatibility?.reason || '等待检查索引配置。' }}
          </div>
        </div>

        <div class="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <div class="rounded-2xl border border-border-soft bg-panel-soft p-4"><div class="text-xs text-text-muted">已索引</div><div class="mt-2 text-2xl font-bold text-success">{{ summary.indexed }}</div></div>
          <div class="rounded-2xl border border-border-soft bg-panel-soft p-4"><div class="text-xs text-text-muted">未索引</div><div class="mt-2 text-2xl font-bold text-blue-700">{{ summary.notIndexed }}</div></div>
          <div class="rounded-2xl border border-border-soft bg-panel-soft p-4"><div class="text-xs text-text-muted">已过期</div><div class="mt-2 text-2xl font-bold text-amber-700">{{ summary.outdated }}</div></div>
          <div class="rounded-2xl border border-border-soft bg-panel-soft p-4"><div class="text-xs text-text-muted">待清理</div><div class="mt-2 text-2xl font-bold text-zinc-600">{{ summary.deleted }}</div></div>
          <div class="rounded-2xl border border-border-soft bg-panel-soft p-4"><div class="text-xs text-text-muted">失败</div><div class="mt-2 text-2xl font-bold text-danger">{{ summary.failed }}</div></div>
          <div class="rounded-2xl border border-border-soft bg-panel-soft p-4"><div class="text-xs text-text-muted">忽略</div><div class="mt-2 text-2xl font-bold text-text-muted">{{ summary.ignored }}</div></div>
        </div>
      </section>

      <section class="mt-4 rounded-2xl border border-border-soft bg-panel-soft p-4">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-sm font-semibold text-text-main">上一次索引元信息</h2>
            <p class="mt-1 text-xs text-text-muted">来自 workspace/.looma/index/index_metadata.json，用于判断当前索引是如何生成的。</p>
          </div>
          <span class="rounded-full border border-border-soft bg-panel px-3 py-1 text-xs text-text-muted">
            {{ indexMetadata ? `版本 ${indexMetadata.indexVersion ?? '—'}` : '暂无元信息' }}
          </span>
        </div>

        <div v-if="indexMetadata" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div class="rounded-xl border border-border-soft bg-panel p-3">
            <div class="text-[11px] font-medium text-text-subtle">最后索引时间</div>
            <div class="mt-1 text-sm font-semibold text-text-main">{{ formatTime(lastBuild?.indexedAt || indexMetadata.updatedAt) }}</div>
            <div class="mt-1 text-[11px] text-text-muted">创建：{{ formatTime(indexMetadata.createdAt) }}</div>
          </div>
          <div class="rounded-xl border border-border-soft bg-panel p-3">
            <div class="text-[11px] font-medium text-text-subtle">文件 / 文档 / Chunks</div>
            <div class="mt-1 text-sm font-semibold text-text-main">
              {{ lastBuild?.fileCount ?? summary.indexed }} / {{ lastBuild?.documentCount ?? summary.indexed }} / {{ lastBuild?.chunkCount ?? '—' }}
            </div>
            <div class="mt-1 text-[11px] text-text-muted">当前 manifest 已索引文件：{{ summary.indexed }}</div>
          </div>
          <div class="rounded-xl border border-border-soft bg-panel p-3">
            <div class="text-[11px] font-medium text-text-subtle">Embedding 模型</div>
            <div class="mt-1 truncate text-sm font-semibold text-text-main">{{ metadataEmbeddingLabel }}</div>
            <div class="mt-1 text-[11px] text-text-muted">维度：{{ indexMetadata.embedding?.dimension ?? '未记录' }}</div>
          </div>
          <div class="rounded-xl border border-border-soft bg-panel p-3">
            <div class="text-[11px] font-medium text-text-subtle">切块大小 / 重叠部分大小</div>
            <div class="mt-1 text-sm font-semibold text-text-main">{{ metadataChunkingLabel }}</div>
            <div class="mt-1 text-[11px] text-text-muted">
              {{ indexMetadata.parser?.type || 'parser' }} v{{ indexMetadata.parser?.version ?? '—' }}
            </div>
          </div>
        </div>
        <div v-else class="rounded-xl border border-dashed border-border-soft bg-panel p-6 text-center text-sm text-text-muted">
          暂无上一次索引元信息。请先执行“增量更新”或“全量重建”。
        </div>
      </section>

      <section v-if="buildLog.length" class="mt-4 rounded-2xl border border-border-soft bg-panel-soft p-4">
        <div class="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Loader2 v-if="isBuilding" :size="14" class="animate-spin" />
          索引任务日志
        </div>
        <div class="max-h-28 overflow-y-auto text-xs leading-5 text-text-muted">
          <div v-for="(line, index) in buildLog" :key="`${index}:${line}`">{{ line }}</div>
        </div>
      </section>

      <section class="mt-5 rounded-2xl border border-border-soft bg-panel-soft">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border-soft p-4">
          <div>
            <h2 class="text-sm font-semibold">文件索引状态</h2>
            <p class="mt-1 text-xs text-text-muted">根据 manifest、文件 hash 和当前 RAG 配置计算。</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <label class="relative">
              <Search :size="14" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
              <input v-model="searchQuery" class="h-9 w-56 rounded-xl border border-border-soft bg-panel pl-8 pr-3 text-xs outline-none focus:border-accent" placeholder="搜索文件路径" />
            </label>
            <select v-model="statusFilter" class="h-9 rounded-xl border border-border-soft bg-panel px-3 text-xs outline-none focus:border-accent">
              <option value="all">全部状态</option>
              <option value="indexed">已索引</option>
              <option value="not_indexed">未索引</option>
              <option value="outdated">已过期</option>
              <option value="deleted">待清理</option>
              <option value="failed">失败</option>
              <option value="ignored">已忽略</option>
            </select>
            <select
              class="h-9 rounded-xl border border-border-soft bg-panel px-3 text-xs outline-none focus:border-accent"
              :value="filePageSize"
              @change="handleFilePageSizeChange"
            >
              <option v-for="size in filePageSizeOptions" :key="size" :value="size">每页 {{ size }} 条</option>
            </select>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="min-w-full text-left text-xs">
            <thead class="bg-panel text-text-muted">
              <tr>
                <th class="px-4 py-3 font-medium">文件</th>
                <th class="px-4 py-3 font-medium">状态</th>
                <th class="px-4 py-3 font-medium">Chunks</th>
                <th class="px-4 py-3 font-medium">最后索引</th>
                <th class="px-4 py-3 font-medium">错误</th>
                <th class="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="file in paginatedFiles"
                :key="`${file.status}:${file.path}`"
                class="cursor-pointer border-t border-border-soft transition-colors hover:bg-panel/70"
                :class="{
                  'bg-accent-soft/60 ring-1 ring-inset ring-accent/20': reindexingFilePath === file.path,
                  'bg-success/5': reindexSuccessPath === file.path,
                }"
                @click="openFileChunks(file)"
              >
                <td class="max-w-[360px] px-4 py-3 text-text-main">
                  <div class="flex items-center gap-2">
                    <Loader2 v-if="reindexingFilePath === file.path" :size="14" class="shrink-0 animate-spin text-accent" />
                    <FileText v-else :size="14" class="shrink-0 text-text-muted" />
                    <div class="min-w-0 flex-1">
                      <div class="truncate">{{ file.path }}</div>
                      <div v-if="reindexingFilePath === file.path" class="mt-1 flex items-center gap-1.5 text-[10px] text-accent">
                        <span class="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                        正在删除旧 chunk 并写入新向量 · {{ reindexElapsedLabel }}
                      </div>
                      <div v-else-if="reindexSuccessPath === file.path" class="mt-1 text-[10px] text-success">刚刚重建完成</div>
                    </div>
                  </div>
                </td>
                <td class="px-4 py-3"><span class="rounded-full border px-2.5 py-1" :class="statusClasses[file.status]">{{ statusLabels[file.status] }}</span></td>
                <td class="px-4 py-3 text-text-muted">{{ file.chunkCount ?? 0 }}</td>
                <td class="px-4 py-3 text-text-muted">{{ formatTime(file.lastIndexedAt) }}</td>
                <td class="max-w-[260px] px-4 py-3 text-danger"><span class="line-clamp-2">{{ file.error || '—' }}</span></td>
                <td class="px-4 py-3 text-right">
                  <div class="inline-flex items-center gap-1">
                    <button
                      v-if="file.status !== 'ignored' && file.status !== 'deleted'"
                      class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-text-muted hover:bg-accent-soft hover:text-text-main disabled:cursor-not-allowed disabled:opacity-60"
                      :class="reindexingFilePath === file.path ? 'bg-accent-soft text-accent' : ''"
                      :disabled="isBuilding || (isFileReindexing && reindexingFilePath !== file.path)"
                      @click.stop="reindexFile(file.path)"
                    >
                      <Loader2 v-if="reindexingFilePath === file.path" :size="12" class="animate-spin" />
                      {{ reindexingFilePath === file.path ? '重建中' : '重建' }}
                    </button>
                    <button v-if="file.status === 'deleted'" class="rounded-lg px-2 py-1 text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50" :disabled="isBuilding || isFileReindexing" @click.stop="deleteFileIndex(file.path)">清理</button>
                  </div>
                </td>
              </tr>
              <tr v-if="filteredFiles.length === 0">
                <td colspan="6" class="px-4 py-10 text-center text-text-muted">
                  <XCircle :size="24" class="mx-auto mb-2 opacity-50" />
                  暂无符合条件的文件。
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="totalFilteredFiles > 0" class="flex flex-wrap items-center justify-between gap-3 border-t border-border-soft px-4 py-3 text-xs text-text-muted">
          <div>
            显示第 {{ filePageStart }}-{{ filePageEnd }} 条，共 {{ totalFilteredFiles }} 条
            <span v-if="(status?.files?.length ?? 0) !== totalFilteredFiles">（已从 {{ status?.files?.length ?? 0 }} 个文件中过滤）</span>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              class="rounded-lg border border-border-soft bg-panel px-2.5 py-1.5 hover:bg-accent-soft disabled:cursor-not-allowed disabled:text-text-subtle disabled:hover:bg-panel"
              :disabled="filePage <= 1"
              @click="goToFilePage(1)"
            >
              首页
            </button>
            <button
              class="rounded-lg border border-border-soft bg-panel px-2.5 py-1.5 hover:bg-accent-soft disabled:cursor-not-allowed disabled:text-text-subtle disabled:hover:bg-panel"
              :disabled="filePage <= 1"
              @click="goToFilePage(filePage - 1)"
            >
              上一页
            </button>
            <button
              v-for="page in filePageNumbers"
              :key="page"
              class="min-w-8 rounded-lg border px-2.5 py-1.5 font-medium transition-colors"
              :class="page === filePage
                ? 'border-accent bg-accent text-white'
                : 'border-border-soft bg-panel hover:bg-accent-soft hover:text-text-main'"
              @click="goToFilePage(page)"
            >
              {{ page }}
            </button>
            <button
              class="rounded-lg border border-border-soft bg-panel px-2.5 py-1.5 hover:bg-accent-soft disabled:cursor-not-allowed disabled:text-text-subtle disabled:hover:bg-panel"
              :disabled="filePage >= fileTotalPages"
              @click="goToFilePage(filePage + 1)"
            >
              下一页
            </button>
            <button
              class="rounded-lg border border-border-soft bg-panel px-2.5 py-1.5 hover:bg-accent-soft disabled:cursor-not-allowed disabled:text-text-subtle disabled:hover:bg-panel"
              :disabled="filePage >= fileTotalPages"
              @click="goToFilePage(fileTotalPages)"
            >
              末页
            </button>
          </div>
        </div>
      </section>
    </main>

    <div v-if="selectedFile" class="fixed inset-0 z-50 flex justify-end bg-black/20" @click="closeChunkDrawer">
      <aside class="flex h-full w-full max-w-3xl flex-col border-l border-border-soft bg-panel shadow-2xl" @click.stop>
        <header class="shrink-0 border-b border-border-soft p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-subtle">Chunk Details</div>
              <h2 class="mt-1 truncate text-base font-bold text-text-main">{{ selectedFile.path }}</h2>
              <p class="mt-1 text-xs text-text-muted">
                状态：{{ statusLabels[selectedFile.status] }} · Manifest Chunks：{{ selectedFile.chunkCount ?? 0 }} · 已读取：{{ fileChunks.length }}
              </p>
            </div>
            <button class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-accent-soft hover:text-text-main" @click="closeChunkDrawer">
              <X :size="16" />
            </button>
          </div>
          <label class="relative mt-4 block">
            <Search :size="14" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input v-model="chunkSearchQuery" class="h-9 w-full rounded-xl border border-border-soft bg-panel-soft pl-8 pr-3 text-xs outline-none focus:border-accent" placeholder="搜索 chunk 文本、ID 或 metadata" />
          </label>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto p-4">
          <div v-if="chunkError" class="mb-4 rounded-xl border border-amber-300/50 bg-amber-50 p-3 text-sm text-amber-700">
            {{ chunkError }}
          </div>
          <div v-if="isLoadingChunks" class="flex h-40 items-center justify-center gap-2 text-sm text-text-muted">
            <Loader2 :size="16" class="animate-spin" />
            正在读取 chunk 详情...
          </div>
          <div v-else-if="filteredChunks.length" class="grid gap-3">
            <article v-for="chunk in filteredChunks" :key="chunk.id" class="rounded-2xl border border-border-soft bg-panel-soft p-4">
              <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                  <div class="text-xs font-semibold text-text-main">Chunk #{{ chunk.index + 1 }}</div>
                  <div class="mt-0.5 truncate font-mono text-[10px] text-text-subtle">{{ chunk.id }}</div>
                </div>
                <div class="flex items-center gap-2">
                  <span class="rounded-full border border-border-soft bg-panel px-2 py-0.5 text-[10px] text-text-muted">{{ chunk.textLength ?? chunk.text.length }} 字符</span>
                  <button class="rounded-lg px-2 py-1 text-xs text-text-muted hover:bg-accent-soft hover:text-text-main" @click="copyChunkText(chunk)">复制</button>
                </div>
              </div>
              <pre class="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border-soft bg-panel p-3 text-xs leading-5 text-text-main">{{ chunk.text }}</pre>
              <details class="mt-3 text-xs text-text-muted">
                <summary class="cursor-pointer select-none hover:text-text-main">Metadata</summary>
                <pre class="mt-2 max-h-40 overflow-y-auto rounded-xl bg-panel p-3 text-[11px] leading-5">{{ JSON.stringify(chunk.metadata, null, 2) }}</pre>
              </details>
            </article>
          </div>
          <div v-else class="flex h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-border-soft text-sm text-text-muted">
            <XCircle :size="24" class="mb-2 opacity-50" />
            没有读取到 chunk。旧索引可能需要全量重建后才能按文件查看。
          </div>
        </div>
      </aside>
    </div>

  </div>
</template>
