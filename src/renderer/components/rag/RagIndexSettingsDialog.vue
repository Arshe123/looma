<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import { AlertTriangle, CheckCircle2, Clock3, FileCode2, FileText, GitBranch, Layers3, Save, Sparkles, X } from 'lucide-vue-next'
import { useSettingsStore } from '@/renderer/stores/settings'
import type { AppSettings, ChunkingStrategy } from '@/shared/utils/app-settings'

type AiSettings = AppSettings['ai']
type IndexingMode = AiSettings['indexingMode']

const props = defineProps<{
  open: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  close: []
  saved: []
  saveAndRebuild: []
}>()

const settingsStore = useSettingsStore()

const strategyOptions: Array<{
  value: ChunkingStrategy
  title: string
  badge: string
  description: string
  icon: any
  enabled: boolean
}> = [
  {
    value: 'fixed',
    title: '固定长度',
    badge: '当前可用',
    description: '按固定 chunk size 和 overlap 切分，稳定可控，适合通用文档。',
    icon: Layers3,
    enabled: true,
  },
  {
    value: 'markdown',
    title: 'Markdown 结构',
    badge: '已支持',
    description: '优先保留标题层级与章节结构，再按大小切分，适合 README、方案、笔记。',
    icon: FileText,
    enabled: true,
  },
  // {
  //   value: 'semantic',
  //   title: '段落语义',
  //   badge: '即将支持',
  //   description: '尽量在段落和句子边界切分，减少语义被截断。',
  //   icon: Sparkles,
  //   enabled: false,
  // },
  // {
  //   value: 'parent_child',
  //   title: '父子块',
  //   badge: '即将支持',
  //   description: '小块用于召回，大块用于回答上下文，适合提升回答完整性。',
  //   icon: GitBranch,
  //   enabled: false,
  // },
  // {
  //   value: 'code_aware',
  //   title: '代码友好',
  //   badge: '预留',
  //   description: '后续保留代码块、函数和配置片段，避免技术内容被切碎。',
  //   icon: FileCode2,
  //   enabled: false,
  // },
]

const indexingModeOptions: Array<{ value: IndexingMode; label: string; description: string }> = [
  { value: 'manual', label: '手动', description: '由你手动点击构建，最稳妥。' },
  { value: 'incremental', label: '自动增量', description: '适合频繁编辑后的轻量同步。' },
  { value: 'idle', label: '应用空闲时自动', description: '尽量在空闲时维护索引。' },
]

const draft = reactive({
  vectorStorePath: '',
  topK: 5,
  chunkSize: 800,
  chunkOverlap: 100,
  chunkingStrategy: 'fixed' as ChunkingStrategy,
  indexingMode: 'manual' as IndexingMode,
})

const original = reactive({
  vectorStorePath: '',
  topK: 5,
  chunkSize: 800,
  chunkOverlap: 100,
  chunkingStrategy: 'fixed' as ChunkingStrategy,
  indexingMode: 'manual' as IndexingMode,
})

const copyFromSettings = (settings: AiSettings) => ({
  vectorStorePath: settings.vectorStorePath,
  topK: settings.topK,
  chunkSize: settings.chunkSize,
  chunkOverlap: settings.chunkOverlap,
  chunkingStrategy: settings.chunkingStrategy,
  indexingMode: settings.indexingMode,
})

const assignState = (target: typeof draft, source: ReturnType<typeof copyFromSettings>) => {
  target.vectorStorePath = source.vectorStorePath
  target.topK = source.topK
  target.chunkSize = source.chunkSize
  target.chunkOverlap = source.chunkOverlap
  target.chunkingStrategy = source.chunkingStrategy
  target.indexingMode = source.indexingMode
}

const resetDraft = () => {
  const snapshot = copyFromSettings(settingsStore.aiSettings)
  assignState(draft, snapshot)
  assignState(original, snapshot)
}

const isChanged = computed(() =>
  draft.vectorStorePath !== original.vectorStorePath
  || draft.topK !== original.topK
  || draft.chunkSize !== original.chunkSize
  || draft.chunkOverlap !== original.chunkOverlap
  || draft.chunkingStrategy !== original.chunkingStrategy
  || draft.indexingMode !== original.indexingMode,
)

const isUnsupportedStrategy = computed(() => !['fixed', 'markdown'].includes(draft.chunkingStrategy))
const requiresFullRebuild = computed(() =>
  draft.vectorStorePath !== original.vectorStorePath
  || draft.chunkSize !== original.chunkSize
  || draft.chunkOverlap !== original.chunkOverlap
  || draft.chunkingStrategy !== original.chunkingStrategy,
)
const retrievalOnlyChanged = computed(() =>
  isChanged.value
  && !requiresFullRebuild.value
  && (draft.topK !== original.topK || draft.indexingMode !== original.indexingMode),
)

const clampNumber = (value: number, min: number, max: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

const saveSettings = async () => {
  draft.topK = clampNumber(Number(draft.topK), 1, 50, original.topK)
  draft.chunkSize = clampNumber(Number(draft.chunkSize), 128, 8192, original.chunkSize)
  draft.chunkOverlap = clampNumber(Number(draft.chunkOverlap), 0, 2048, original.chunkOverlap)

  await settingsStore.setAiSettings({
    vectorStorePath: draft.vectorStorePath.trim() || '.looma/rag-index',
    topK: draft.topK,
    chunkSize: draft.chunkSize,
    chunkOverlap: draft.chunkOverlap,
    chunkingStrategy: draft.chunkingStrategy,
    indexingMode: draft.indexingMode,
  })
  resetDraft()
}

const handleSave = async () => {
  await saveSettings()
  emit('saved')
  emit('close')
}

const handleSaveAndRebuild = async () => {
  if (isUnsupportedStrategy.value) return
  await saveSettings()
  emit('saved')
  emit('close')
  emit('saveAndRebuild')
}

const handleClose = () => {
  resetDraft()
  emit('close')
}

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && props.open) {
    handleClose()
  }
}

watch(() => props.open, (open) => {
  if (open) resetDraft()
}, { immediate: true })

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', handleKeydown)
}

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleKeydown)
  }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 flex items-end justify-center bg-black/35 p-0 backdrop-blur-sm md:items-center md:p-5" @click.self="handleClose">
      <section class="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[1.75rem] border border-border-soft bg-panel shadow-2xl md:max-h-[88vh] md:max-w-4xl md:rounded-[1.75rem]">
        <header class="shrink-0 border-b border-border-soft bg-panel-soft/80 px-5 py-4">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-subtle">RAG Settings</div>
              <h2 class="mt-1 text-lg font-bold tracking-[-0.03em] text-text-main">索引库设置</h2>
              <p class="mt-1 text-sm text-text-muted">调整检索、切分和索引更新策略。涉及切分的变更建议全量重建。</p>
            </div>
            <button class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-text-muted hover:bg-panel hover:text-text-main" @click="handleClose">
              <X :size="17" />
            </button>
          </div>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <section class="rounded-2xl border border-border-soft bg-panel-soft/70 p-4">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 class="text-sm font-semibold text-text-main">索引切分选项</h3>
                <p class="mt-1 text-xs text-text-muted">Markdown 结构已支持；其它高级策略暂不改变后端切分逻辑。</p>
              </div>
              <span class="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent">策略预设</span>
            </div>

            <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <button
                v-for="option in strategyOptions"
                :key="option.value"
                type="button"
                class="group rounded-2xl border p-3 text-left transition disabled:cursor-not-allowed"
                :class="draft.chunkingStrategy === option.value
                  ? 'border-accent bg-accent-soft text-text-main shadow-sm'
                  : 'border-border-soft bg-panel hover:border-accent/40 hover:bg-accent-soft/40'"
                :disabled="disabled"
                @click="draft.chunkingStrategy = option.value"
              >
                <div class="flex items-start gap-3">
                  <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-panel text-accent shadow-sm">
                    <component :is="option.icon" :size="16" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="flex flex-wrap items-center gap-2">
                      <span class="text-sm font-semibold text-text-main">{{ option.title }}</span>
                      <span
                        class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                        :class="option.enabled ? 'bg-success/10 text-success' : 'bg-amber-50 text-amber-700'"
                      >
                        {{ option.badge }}
                      </span>
                    </span>
                    <span class="mt-1 block text-xs leading-5 text-text-muted">{{ option.description }}</span>
                  </span>
                </div>
              </button>
            </div>
          </section>

          <div v-if="isUnsupportedStrategy" class="mt-4 rounded-2xl border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-800">
            <div class="flex items-start gap-2">
              <AlertTriangle :size="16" class="mt-0.5 shrink-0" />
              <p>当前选择的是预留策略。可以先保存该选择用于后续版本，但本版本重建索引只支持“固定长度”和“Markdown 结构”实际切分，因此已禁用“保存并全量重建”。</p>
            </div>
          </div>

          <div v-else-if="requiresFullRebuild" class="mt-4 rounded-2xl border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-800">
            <div class="flex items-start gap-2">
              <AlertTriangle :size="16" class="mt-0.5 shrink-0" />
              <p>切分参数或向量存储位置已变化。仅保存会让索引状态显示“需要重建”；建议保存后执行全量重建，避免旧 chunk 继续参与检索。</p>
            </div>
          </div>

          <div v-else-if="retrievalOnlyChanged" class="mt-4 rounded-2xl border border-success/30 bg-success/10 p-3 text-sm text-success">
            <div class="flex items-start gap-2">
              <CheckCircle2 :size="16" class="mt-0.5 shrink-0" />
              <p>当前变更无需重建索引，保存后会在下一次检索时生效。</p>
            </div>
          </div>

          <section class="mt-5 grid gap-4">
            <label class="grid gap-2 text-sm text-text-main">
              <span class="text-xs font-semibold text-text-main">向量存储位置</span>
              <input
                v-model="draft.vectorStorePath"
                class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent disabled:opacity-60"
                :disabled="disabled"
                spellcheck="false"
                placeholder=".looma/rag-index"
              />
              <span class="text-xs leading-5 text-text-muted">修改后会切换索引目录，旧索引不会自动迁移。</span>
            </label>

            <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-4">
              <label class="grid gap-2 text-sm text-text-main">
                <span class="text-xs font-semibold text-text-main">检索片段数 Top K</span>
                <input
                  v-model.number="draft.topK"
                  class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent disabled:opacity-60"
                  :disabled="disabled"
                  type="number"
                  min="1"
                  max="50"
                  step="1"
                />
                <span class="text-xs leading-5 text-text-muted">每次提问取回的相关片段数量，无需重建。</span>
              </label>

              <label class="grid gap-2 text-sm text-text-main">
                <span class="text-xs font-semibold text-text-main">切块大小</span>
                <input
                  v-model.number="draft.chunkSize"
                  class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent disabled:opacity-60"
                  :disabled="disabled || isUnsupportedStrategy"
                  type="number"
                  min="128"
                  max="8192"
                  step="1"
                />
                <span class="text-xs leading-5 text-text-muted">固定长度策略下每个文本块的目标长度。</span>
              </label>

              <label class="grid gap-2 text-sm text-text-main">
                <span class="text-xs font-semibold text-text-main">切块重叠</span>
                <input
                  v-model.number="draft.chunkOverlap"
                  class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent disabled:opacity-60"
                  :disabled="disabled || isUnsupportedStrategy"
                  type="number"
                  min="0"
                  max="2048"
                  step="1"
                />
                <span class="text-xs leading-5 text-text-muted">相邻文本块保留的上下文重叠长度。</span>
              </label>
            </div>

            <!-- <label class="grid gap-2 text-sm text-text-main">
              <span class="text-xs font-semibold text-text-main">索引更新策略</span>
              <select
                v-model="draft.indexingMode"
                class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none focus:border-accent disabled:opacity-60"
                :disabled="disabled"
              >
                <option v-for="option in indexingModeOptions" :key="option.value" :value="option.value">
                  {{ option.label }} — {{ option.description }}
                </option>
              </select>
              <span class="text-xs leading-5 text-text-muted">手动更稳，自动策略后续可接入文件监听或空闲任务。</span>
            </label> -->
          </section>
        </div>

        <footer class="shrink-0 border-t border-border-soft bg-panel-soft/80 px-5 py-4">
          <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div class="flex flex-wrap items-center justify-end gap-2">
              <button class="inline-flex h-10 items-center justify-center rounded-xl border border-border-soft bg-panel px-4 text-sm font-medium text-text-main hover:bg-panel-soft" @click="handleClose">
                取消
              </button>
              <button
                class="inline-flex h-10 items-center gap-2 rounded-xl border border-border-soft bg-panel px-4 text-sm font-medium text-text-main hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="disabled || !isChanged"
                @click="handleSave"
              >
                <Save :size="15" />
                仅保存设置
              </button>
              <button
                class="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-accent-soft disabled:text-text-muted"
                :disabled="disabled || !isChanged || !requiresFullRebuild || isUnsupportedStrategy"
                @click="handleSaveAndRebuild"
              >
                <Layers3 :size="15" />
                保存并全量重建
              </button>
            </div>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
