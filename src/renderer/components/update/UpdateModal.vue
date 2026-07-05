<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AlertTriangle, CheckCircle2, Download, Loader, RefreshCw, Sparkles, X } from 'lucide-vue-next'
import { checkForUpdate, type UpdateCheckResult } from '@/renderer/services/versionApi'

const props = defineProps<{
  open: boolean
  currentVersion: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

type Status = 'checking' | 'update' | 'latest' | 'error'

const status = ref<Status>('checking')
const result = ref<UpdateCheckResult | null>(null)
const errorMessage = ref('')
const errorDetail = ref('')
const opening = ref(false)

const isForce = computed(() => status.value === 'update' && Boolean(result.value?.forceUpdate))
const latest = computed(() => result.value?.latest ?? null)
// 强制更新时禁止关闭（只能点“立即更新”）
const dismissible = computed(() => !isForce.value)

const runCheck = async () => {
  status.value = 'checking'
  result.value = null
  errorMessage.value = ''
  errorDetail.value = ''

  try {
    const res = await checkForUpdate(props.currentVersion)
    if (!res || !res.hasUpdate) {
      status.value = 'latest'
      result.value = res
      return
    }
    result.value = res
    status.value = 'update'
  } catch (error) {
    status.value = 'error'
    errorMessage.value = '检查更新失败，请检查网络后重试'
    errorDetail.value = error instanceof Error ? error.message : String(error)
  }
}

const close = () => {
  if (!dismissible.value) return
  emit('close')
}

const closeFromOverlay = () => {
  if (!dismissible.value) return
  emit('close')
}

const openDownload = async () => {
  const url = latest.value?.downloadUrl
  if (!url) {
    errorMessage.value = '暂无下载地址，请前往官网获取最新版本'
    return
  }
  opening.value = true
  try {
    const res = await window.electronAPI.app.openExternal(url)
    if (!res?.success) {
      errorMessage.value = '无法打开下载页面'
      errorDetail.value = res?.error || ''
    }
  } catch (error) {
    errorMessage.value = '无法打开下载页面'
    errorDetail.value = error instanceof Error ? error.message : String(error)
  } finally {
    opening.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) runCheck()
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
          <div v-if="status === 'update' && !isForce" class="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-xs font-bold text-accent">
            <Sparkles :size="13" />
            <span>发现新版本</span>
          </div>
          <div v-else-if="isForce" class="inline-flex items-center gap-1.5 rounded-full bg-danger/10 px-3 py-1 text-xs font-bold text-danger">
            <AlertTriangle :size="13" />
            <span>必须更新</span>
          </div>
          <div v-else-if="status === 'latest'" class="inline-flex items-center gap-1.5 rounded-full bg-panel-soft px-3 py-1 text-xs font-bold text-text-muted">
            <CheckCircle2 :size="13" />
            <span>已是最新</span>
          </div>
          <div v-else-if="status === 'checking'" class="inline-flex items-center gap-1.5 rounded-full bg-panel-soft px-3 py-1 text-xs font-bold text-text-muted">
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
      <div v-if="status === 'checking'" class="py-10 flex flex-col items-center justify-center gap-3">
        <Loader :size="34" class="animate-spin text-accent" />
        <p class="text-sm text-text-muted">正在检查更新...</p>
      </div>

      <!-- 已是最新 -->
      <div v-else-if="status === 'latest'" class="py-8 flex flex-col items-center justify-center gap-3 text-center">
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
          <p class="mt-1 text-sm text-text-muted">{{ errorMessage }}</p>
          <details v-if="errorDetail" class="mt-2 text-left">
            <summary class="cursor-pointer text-xs text-text-subtle select-none">技术详情</summary>
            <span class="mt-1 block text-xs text-text-subtle break-all">{{ errorDetail }}</span>
          </details>
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

      <!-- 有可用更新（普通 / 强制） -->
      <div v-else-if="status === 'update' && latest">
        <!-- 强制更新警示 -->
        <div
          v-if="isForce"
          class="mt-4 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 text-sm font-medium text-danger"
        >
          <AlertTriangle :size="16" class="shrink-0" />
          <span>当前版本 v{{ currentVersion }} 过低，更新后才能继续使用</span>
        </div>

        <h2 class="mt-4 text-xl font-bold text-text-main">v{{ latest.version }} 版本更新</h2>
        <p class="mt-1 text-sm text-text-muted">
          <span v-if="latest.releaseDate">发布日期：{{ latest.releaseDate }}</span>
          <span v-if="latest.releaseDate && latest.minVersion" class="text-text-subtle"> · </span>
          <span v-if="latest.minVersion">最低要求：v{{ latest.minVersion }}</span>
        </p>
        <p class="mt-0.5 text-xs text-text-subtle">当前版本 v{{ currentVersion }}</p>

        <div v-if="latest.notes" class="mt-4 rounded-lg border border-border-soft bg-panel-soft px-4 py-3 max-h-[200px] overflow-y-auto">
          <div class="text-xs font-bold uppercase tracking-wide text-text-subtle">更新内容</div>
          <p class="mt-2 text-sm text-text-muted leading-relaxed whitespace-pre-line">{{ latest.notes }}</p>
        </div>

        <p v-if="errorMessage" class="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {{ errorMessage }}
          <details v-if="errorDetail" class="mt-1">
            <summary class="cursor-pointer text-xs text-red-500/80 select-none">技术详情</summary>
            <span class="mt-1 block text-xs text-red-500/80 break-all">{{ errorDetail }}</span>
          </details>
        </p>

        <div class="mt-6 flex gap-2" :class="isForce ? '' : 'justify-end'">
          <button
            v-if="!isForce"
            type="button"
            class="h-11 px-5 rounded-lg text-sm font-semibold text-text-muted hover:bg-accent-soft hover:text-accent cursor-pointer"
            @click="close"
          >
            稍后提醒
          </button>
          <button
            type="button"
            :disabled="opening"
            class="h-11 px-5 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold cursor-pointer inline-flex items-center justify-center gap-1.5"
            :class="isForce ? 'flex-1' : ''"
            @click="openDownload"
          >
            <Download :size="16" />
            <span>{{ opening ? '正在打开...' : '立即更新' }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
