<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { AlertTriangle, CheckCircle2, Download, Loader, RefreshCw, Sparkles, X } from 'lucide-vue-next'
import type { UpdateState } from '@/shared/types/app-update'
import { checkForUpdate } from '@/renderer/services/versionApi'
import { renderReleaseNotes } from '@/renderer/utils/release-notes-renderer'
import { shouldUseManualUpdate } from '@/shared/utils/update-policy'

const props = defineProps<{
  open: boolean
  currentVersion: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const state = ref<UpdateState>({ status: 'idle' })
const actionPending = ref(false)
const manualDownloadUrl = ref<string | null>(null)
const manualUpdate = shouldUseManualUpdate(window.electronAPI.platform)
const status = computed(() => state.value.status)
const dismissible = computed(() => !actionPending.value)
const progress = computed(() => Math.max(0, Math.min(100, state.value.percent ?? 0)))
const releaseNotesHtml = computed(() => renderReleaseNotes(state.value.releaseNotes || ''))

const formatBytes = (bytes?: number) => {
  if (!bytes || bytes < 1) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const runCheck = async () => {
  actionPending.value = true
  try {
    if (manualUpdate) {
      const result = await checkForUpdate(props.currentVersion)
      manualDownloadUrl.value = result?.latest.downloadUrl ?? null
      state.value = result?.hasUpdate
        ? {
            status: 'available',
            version: result.latest.version,
            releaseName: null,
            releaseNotes: result.latest.notes,
            releaseDate: result.latest.releaseDate,
          }
        : { status: 'not-available' }
      return
    }
    const result = await window.electronAPI.app.update.check()
    state.value = result.state
  } catch (error) {
    console.error('[update:check] IPC request failed', error)
    state.value = { status: 'error', error: '暂时无法检查更新，请稍后重试。' }
  } finally {
    actionPending.value = false
  }
}

const openManualDownload = async () => {
  if (!manualDownloadUrl.value) {
    state.value = { ...state.value, status: 'error', error: '最新版本没有可用的下载地址' }
    return
  }
  actionPending.value = true
  try {
    const result = await window.electronAPI.app.openExternal(manualDownloadUrl.value)
    if (!result.success) {
      console.error('[update:open-download] Failed to open download page', result.error)
      state.value = { ...state.value, status: 'error', error: '无法打开下载页面，请稍后重试。' }
    }
  } catch (error) {
    console.error('[update:open-download] Failed to open download page', error)
    state.value = { ...state.value, status: 'error', error: '无法打开下载页面，请稍后重试。' }
  } finally {
    actionPending.value = false
  }
}

const handleReleaseNotesClick = (event: MouseEvent) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const anchor = target.closest<HTMLAnchorElement>('a[href]')
  if (!anchor) return
  event.preventDefault()
  const href = anchor?.getAttribute('href') || ''
  if (!/^https?:\/\//i.test(href)) return
  void window.electronAPI.app.openExternal(href)
}

const close = () => {
  if (!dismissible.value) return
  emit('close')
}

const closeFromOverlay = () => {
  if (!dismissible.value) return
  emit('close')
}

const downloadUpdate = async () => {
  actionPending.value = true
  try {
    const result = await window.electronAPI.app.update.download()
    state.value = result.state
  } catch (error) {
    console.error('[update:download] IPC request failed', error)
    state.value = { ...state.value, status: 'error', error: '更新下载失败，请检查网络后重试。' }
  } finally {
    actionPending.value = false
  }
}

const installUpdate = async () => {
  actionPending.value = true
  try {
    const result = await window.electronAPI.app.update.install()
    state.value = result.state
    if (!result.success) actionPending.value = false
  } catch (error) {
    console.error('[update:install] IPC request failed', error)
    state.value = { ...state.value, status: 'error', error: '安装更新失败，请稍后重试。' }
    actionPending.value = false
  }
}

const stopListening = window.electronAPI.app.update.onState(nextState => {
  state.value = nextState
})
onBeforeUnmount(stopListening)

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    if (manualUpdate) {
      await runCheck()
      return
    }
    const current = await window.electronAPI.app.update.getState()
    state.value = current
    if (current.status === 'idle' || current.status === 'not-available' || current.status === 'error') {
      await runCheck()
    }
  },
)
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-overlay flex items-center justify-center p-6"
    @pointerdown.self="closeFromOverlay"
  >
    <div
      class="w-[440px] max-w-[92vw] rounded-xl border border-border-soft bg-panel shadow-2xl shadow-black/25 px-8 py-7"
      @pointerdown.stop
    >
      <!-- 顶部标题栏 -->
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div v-if="status === 'available'" class="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-xs font-bold text-accent">
            <Sparkles :size="13" />
            <span>发现新版本</span>
          </div>
          <div v-else-if="status === 'downloading'" class="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-xs font-bold text-accent">
            <Download :size="13" />
            <span>正在下载</span>
          </div>
          <div v-else-if="status === 'downloaded'" class="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-bold text-success">
            <CheckCircle2 :size="13" />
            <span>下载完成</span>
          </div>
          <div v-else-if="status === 'not-available'" class="inline-flex items-center gap-1.5 rounded-full bg-panel-soft px-3 py-1 text-xs font-bold text-text-muted">
            <CheckCircle2 :size="13" />
            <span>已是最新</span>
          </div>
          <div v-else class="inline-flex items-center gap-1.5 rounded-full bg-panel-soft px-3 py-1 text-xs font-bold text-text-muted">
            <RefreshCw :size="13" />
            <span>检查更新</span>
          </div>
        </div>
        <button
          v-if="dismissible"
          type="button"
          class="w-8 h-8 inline-flex items-center justify-center rounded-md text-text-muted hover:bg-accent-soft hover:text-text-main cursor-pointer shrink-0"
          title="关闭"
          @click="close"
        >
          <X :size="18" />
        </button>
      </div>

      <!-- 正在检查 -->
      <div v-if="status === 'idle' || status === 'checking'" class="py-10 flex flex-col items-center justify-center gap-3">
        <Loader :size="34" class="animate-spin text-accent" />
        <p class="text-sm text-text-muted">正在检查更新...</p>
      </div>

      <!-- 已是最新 -->
      <div v-else-if="status === 'not-available'" class="py-8 flex flex-col items-center justify-center gap-3 text-center">
        <CheckCircle2 :size="40" class="text-success" />
        <div>
          <h2 class="text-lg font-bold text-text-main">已是最新版本</h2>
          <p class="mt-1 text-sm text-text-muted">当前 v{{ currentVersion }} 已是最新版本</p>
        </div>
        <button
          type="button"
          class="mt-2 w-full h-11 rounded-lg border border-border-soft bg-surface hover:bg-panel-soft text-sm font-semibold text-text-main cursor-pointer"
          @click="close"
        >
          确定
        </button>
      </div>

      <!-- 检查失败 -->
      <div v-else-if="status === 'error'" class="py-6 flex flex-col items-center gap-4 text-center">
        <AlertTriangle :size="38" class="text-warning" />
        <div>
          <h2 class="text-lg font-bold text-text-main">检查更新失败</h2>
          <p class="mt-1 text-sm text-text-muted">{{ state.error || '请检查网络后重试' }}</p>
        </div>
        <div class="w-full flex gap-2">
          <button
            type="button"
            class="flex-1 h-11 rounded-lg border border-border-soft bg-surface hover:bg-panel-soft text-sm font-semibold text-text-main cursor-pointer"
            @click="close"
          >
            关闭
          </button>
          <button
            type="button"
            class="flex-1 h-11 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-semibold cursor-pointer inline-flex items-center justify-center gap-1.5"
            @click="runCheck"
          >
            <RefreshCw :size="15" />
            <span>重试</span>
          </button>
        </div>
      </div>

      <!-- 有可用更新 / 下载中 / 下载完成 -->
      <div v-else-if="status === 'available' || status === 'downloading' || status === 'downloaded'">
        <h2 class="mt-4 text-xl font-bold text-text-main">v{{ state.version }} 版本更新</h2>
        <p class="mt-1 text-sm text-text-muted">
          <span v-if="state.releaseDate">发布日期：{{ state.releaseDate }}</span>
          <span v-else-if="state.releaseName">{{ state.releaseName }}</span>
        </p>
        <p class="mt-0.5 text-xs text-text-subtle">当前版本 v{{ currentVersion }}</p>

        <div v-if="manualUpdate" class="mt-4 rounded-lg border border-border-soft bg-panel-soft px-4 py-3 text-sm text-text-muted leading-relaxed">
          下载完成后，将新版 Looma 拖入“应用程序”并选择“替换”即可，无需先卸载旧版本。
        </div>

        <div v-if="state.releaseNotes" class="mt-4 rounded-lg border border-border-soft bg-panel-soft px-4 py-3 max-h-[200px] overflow-y-auto">
          <div class="text-xs font-bold uppercase tracking-wide text-text-subtle">更新内容</div>
          <div
            class="release-notes-content mt-2 text-sm text-text-muted leading-relaxed"
            @click="handleReleaseNotesClick"
            v-html="releaseNotesHtml"
          />
        </div>

        <div v-if="status === 'downloading'" class="mt-5">
          <div class="mb-2 flex items-center justify-between text-xs text-text-muted">
            <span>正在下载更新…</span>
            <span>{{ progress.toFixed(1) }}%</span>
          </div>
          <div class="h-2 overflow-hidden rounded-full bg-panel-soft">
            <div class="h-full rounded-full bg-accent transition-[width] duration-200" :style="{ width: `${progress}%` }" />
          </div>
          <div v-if="state.transferred && state.total" class="mt-2 text-right text-xs text-text-subtle">
            {{ formatBytes(state.transferred) }} / {{ formatBytes(state.total) }}
          </div>
        </div>

        <div v-if="status === 'downloaded'" class="mt-5 flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-success">
          <CheckCircle2 :size="16" class="shrink-0" />
          <span>更新已下载，重启 Looma 后将自动完成安装</span>
        </div>

        <div class="mt-6 flex justify-end gap-2">
          <button
            v-if="status !== 'downloading'"
            type="button"
            class="h-11 px-5 rounded-lg text-sm font-semibold text-text-muted hover:bg-accent-soft hover:text-accent cursor-pointer"
            @click="close"
          >
            稍后提醒
          </button>
          <button
            type="button"
            :disabled="actionPending || status === 'downloading'"
            class="h-11 px-5 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold cursor-pointer inline-flex items-center justify-center gap-1.5"
            @click="manualUpdate ? openManualDownload() : (status === 'downloaded' ? installUpdate() : downloadUpdate())"
          >
            <Loader v-if="status === 'downloading'" :size="16" class="animate-spin" />
            <RefreshCw v-else-if="status === 'downloaded'" :size="16" />
            <Download v-else :size="16" />
            <span v-if="status === 'downloading'">正在下载…</span>
            <span v-else-if="status === 'downloaded'">重启并安装</span>
            <span v-else>{{ manualUpdate ? '前往下载' : '立即更新' }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.release-notes-content :deep(> :first-child) { margin-top: 0; }
.release-notes-content :deep(> :last-child) { margin-bottom: 0; }
.release-notes-content :deep(p) { margin: 0.45rem 0; }
.release-notes-content :deep(h1),
.release-notes-content :deep(h2),
.release-notes-content :deep(h3),
.release-notes-content :deep(h4),
.release-notes-content :deep(h5),
.release-notes-content :deep(h6) {
  margin: 0.75rem 0 0.35rem;
  color: var(--text-main);
  font-size: 0.95rem;
  font-weight: 700;
  line-height: 1.4;
}
.release-notes-content :deep(ul),
.release-notes-content :deep(ol) { margin: 0.45rem 0; padding-left: 1.35rem; }
.release-notes-content :deep(ul) { list-style: disc; }
.release-notes-content :deep(ol) { list-style: decimal; }
.release-notes-content :deep(li) { margin: 0.2rem 0; }
.release-notes-content :deep(strong),
.release-notes-content :deep(b) { color: var(--text-main); font-weight: 700; }
.release-notes-content :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.release-notes-content :deep(code) {
  border-radius: 4px;
  background: var(--surface);
  padding: 0.1em 0.3em;
  color: var(--text-main);
  font-size: 0.9em;
}
.release-notes-content :deep(pre) {
  margin: 0.55rem 0;
  overflow-x: auto;
  border-radius: 6px;
  background: var(--surface);
  padding: 0.65rem;
  color: var(--text-main);
  white-space: pre-wrap;
}
.release-notes-content :deep(pre code) { padding: 0; background: transparent; }
.release-notes-content :deep(blockquote) {
  margin: 0.55rem 0;
  border-left: 3px solid var(--border-soft);
  padding-left: 0.75rem;
}
.release-notes-content :deep(table) { width: 100%; border-collapse: collapse; }
.release-notes-content :deep(th),
.release-notes-content :deep(td) { border: 1px solid var(--border-soft); padding: 0.35rem 0.5rem; }
.release-notes-content :deep(.looma-link-icon) { display: none; }
</style>
