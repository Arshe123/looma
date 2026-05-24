<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '@/store/settings'
import { useOllamaStore } from '@/store/ollama'
import ModelSelectCard, { type ModelOption } from './ModelSelectCard.vue'
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Download,
  HardDrive,
  Link,
  Loader2,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-vue-next'

type ModelKind = 'llm' | 'embed'

const defaultLlmModels = ['qwen2.5:7b', 'qwen2.5:3b', 'llama3.1:8b', 'deepseek-r1:7b']
const defaultEmbedModels = ['bge-m3:latest', 'nomic-embed-text:latest', 'mxbai-embed-large:latest']
const modelMetadata: Record<string, { desc: string; size?: string }> = {
  'qwen2.5:7b': { desc: '通用中文能力较好，适合日常笔记问答', size: '约 4.7 GB' },
  'qwen2.5:3b': { desc: '响应更轻量，适合低配置设备和快速任务', size: '约 2.0 GB' },
  'llama3.1:8b': { desc: '英文能力较好，适合通用对话和写作', size: '约 4.9 GB' },
  'deepseek-r1:7b': { desc: '偏推理任务，适合分析和步骤拆解', size: '约 4.7 GB' },
  'bge-m3:latest': { desc: '多语言向量模型，适合 RAG 检索', size: '约 1.2 GB' },
  'nomic-embed-text:latest': { desc: '文本向量模型，适合本地知识库检索', size: '约 274 MB' },
  'mxbai-embed-large:latest': { desc: '高质量嵌入模型，适合语义检索', size: '约 670 MB' },
}

const settingsStore = useSettingsStore()
const ollamaStore = useOllamaStore()
const ollamaModels = ref<string[]>([])
const isLoadingModels = ref(false)
const ollamaError = ref('')
const openModelPicker = ref<ModelKind | null>(null)

const aiSettings = computed(() => settingsStore.aiSettings)
const llmNeedsPull = computed(() => Boolean(aiSettings.value.llmModel && !ollamaModels.value.includes(aiSettings.value.llmModel)))
const embedNeedsPull = computed(() => Boolean(aiSettings.value.embedModel && !ollamaModels.value.includes(aiSettings.value.embedModel)))
const installedModelSet = computed(() => new Set(ollamaModels.value))
const isPullingLlm = computed(() => ollamaStore.isPullingModel(aiSettings.value.llmModel))
const isPullingEmbed = computed(() => ollamaStore.isPullingModel(aiSettings.value.embedModel))

const isModelInstalled = (model: string) => installedModelSet.value.has(model)

const getModelDescription = (model: string) => {
  return modelMetadata[model]?.desc ?? '已安装的本地模型'
}

const getModelSize = (model: string) => {
  return modelMetadata[model]?.size ?? ''
}

const buildModelOptions = (defaults: string[], selectedModel: string): ModelOption[] => {
  const names = new Set<string>()
  for (const model of defaults) names.add(model)
  for (const model of ollamaModels.value) names.add(model)
  if (selectedModel) names.add(selectedModel)

  return Array.from(names).map((name) => ({
    name,
    installed: isModelInstalled(name),
    selected: name === selectedModel,
    desc: getModelDescription(name),
    size: getModelSize(name),
  }))
}

const llmModelOptions = computed(() => buildModelOptions(defaultLlmModels, aiSettings.value.llmModel))
const embedModelOptions = computed(() => buildModelOptions(defaultEmbedModels, aiSettings.value.embedModel))

const loadOllamaModels = async () => {
  if (isLoadingModels.value) return
  isLoadingModels.value = true
  ollamaError.value = ''
  try {
    const result = await window.electronAPI.ollama.listModels(aiSettings.value.ollamaBaseUrl)
    if (!result.success) {
      ollamaModels.value = []
      ollamaError.value = result.error || '无法读取 Ollama 模型列表。'
      return
    }
    ollamaStore.markInstalled(true)
    ollamaModels.value = result.data?.models ?? []
  } catch (error: any) {
    ollamaModels.value = []
    ollamaError.value = error?.message ?? String(error)
  } finally {
    isLoadingModels.value = false
  }
}

const updateAiSetting = async (key: 'ollamaBaseUrl' | 'llmModel' | 'embedModel' | 'vectorStorePath', value: string) => {
  await settingsStore.setAiSettings({ [key]: value })
  if (key === 'ollamaBaseUrl') {
    await ollamaStore.checkInstalled(aiSettings.value.ollamaBaseUrl)
    await loadOllamaModels()
  }
}

const downloadOllama = async () => {
  await ollamaStore.downloadInstaller(aiSettings.value.ollamaBaseUrl)
}

const closeModelPicker = () => {
  openModelPicker.value = null
}

const selectModel = async (kind: ModelKind, model: string) => {
  await updateAiSetting(kind === 'llm' ? 'llmModel' : 'embedModel', model)
  closeModelPicker()
}

const pullModel = async (kind: ModelKind, targetModel?: string, selectAfterPull = true) => {
  const model = (targetModel || (kind === 'llm' ? aiSettings.value.llmModel : aiSettings.value.embedModel)).trim()
  if (!model.trim()) return

  const title = kind === 'llm' ? '下载 LLM 模型' : '下载 Embedding 模型'
  ollamaError.value = ''
  if (selectAfterPull) {
    await updateAiSetting(kind === 'llm' ? 'llmModel' : 'embedModel', model)
  }
  closeModelPicker()
  await ollamaStore.pullModel(aiSettings.value.ollamaBaseUrl, model, title)
}

const deleteModel = async (model: string) => {
  const name = model.trim()
  if (!name) return
  const confirmation = await window.electronAPI.app.showMessageBox({
    type: 'warning',
    buttons: ['取消', '删除'],
    defaultId: 0,
    cancelId: 0,
    title: '删除模型',
    message: `确定要删除模型 ${name} 吗？`,
    detail: '删除后需要重新下载才能再次使用该模型。',
  })
  if (confirmation.response !== 1) return

  ollamaError.value = ''
  const result = await ollamaStore.deleteModel(aiSettings.value.ollamaBaseUrl, name)
  if (!result.success) {
    ollamaError.value = result.error || `删除模型 ${name} 失败。`
  }
}

onMounted(async () => {
  const installed = await ollamaStore.checkInstalled(aiSettings.value.ollamaBaseUrl)
  if (installed) {
    loadOllamaModels().catch(() => {})
  }
})

watch(
  () => ollamaStore.modelListVersion,
  () => {
    if (ollamaStore.installed) {
      loadOllamaModels().catch(() => {})
    }
  }
)
</script>

<template>
  <div class="mx-auto flex w-full max-w-4xl flex-col gap-5">
    <div class="grid gap-5 bg-panel-soft/40 p-5">
      <section class="rounded-2xl border border-border-soft bg-panel p-4 shadow-sm">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <HardDrive :size="15" class="text-text-muted" />
            <h2 class="text-sm font-semibold text-text-main">接入方式</h2>
          </div>
          <span class="text-[11px] text-text-subtle">Provider</span>
        </div>

        <div class="rounded-2xl border border-accent/30 bg-accent-soft/60 p-3">
          <div class="flex items-center gap-2 justify-between">
            <span class="text-sm font-medium text-text-main">本地 Ollama</span>
            <span
              v-if="ollamaStore.isChecking"
              class="inline-flex items-center gap-1 text-[11px] font-medium text-text-muted"
            >
              <Loader2 :size="14" class="animate-spin" />
              检测中
            </span>
            <CheckCircle2 v-else-if="ollamaStore.installed" :size="16" class="shrink-0 text-success" />
            <button
              v-else
              type="button"
              class="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-3 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-accent-soft disabled:text-text-muted"
              :disabled="ollamaStore.isDownloading"
              @click="downloadOllama"
            >
              <Loader2 v-if="ollamaStore.isDownloading" :size="13" class="animate-spin" />
              <Download v-else :size="13" />
              <span>{{ ollamaStore.isDownloading ? '下载中' : '下载' }}</span>
            </button>
          </div>
          <div
            v-if="!ollamaStore.isChecking && !ollamaStore.installed"
            class="mt-2 text-xs font-medium text-danger"
          >
            未下载 Ollama
          </div>
          <p class="mt-1 text-xs leading-5 text-text-muted">
            使用本机模型，适合隐私和离线场景。当前应用仅支持 Ollama 接入。
          </p>
        </div>
      </section>
      <section v-if="ollamaStore.installed" class="rounded-2xl border border-border-soft bg-panel p-4 shadow-sm">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <SlidersHorizontal :size="15" class="text-text-muted" />
            <h2 class="text-sm font-semibold text-text-main">基础配置</h2>
          </div>
          <span class="text-[11px] text-text-subtle">Local</span>
        </div>

        <div class="grid gap-4">
          <label class="grid gap-2 text-sm text-text-main">
            <span class="flex items-center justify-between gap-3">
              <span class="text-xs font-medium text-text-main">Ollama 地址</span>
              <span class="text-[10px] text-text-subtle">Base URL</span>
            </span>
            <span class="flex h-10 items-center gap-2 rounded-xl border border-border-soft bg-panel-soft px-3 focus-within:border-accent">
              <Link :size="14" class="shrink-0 text-text-subtle" />
              <input
                class="min-w-0 flex-1 bg-transparent text-sm text-text-main outline-none placeholder:text-text-subtle"
                :value="aiSettings.ollamaBaseUrl"
                spellcheck="false"
                @change="updateAiSetting('ollamaBaseUrl', ($event.target as HTMLInputElement).value)"
              />
            </span>
          </label>

          <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-4">
            <ModelSelectCard
              title="LLM 模型"
              subtitle="Chat model"
              :model-value="aiSettings.llmModel"
              :options="llmModelOptions"
              :open="openModelPicker === 'llm'"
              :needs-pull="llmNeedsPull"
              :is-pulling="isPullingLlm"
              :is-model-pulling="ollamaStore.isPullingModel"
              :is-model-deleting="ollamaStore.isDeletingModel"
              @update:open="(open) => openModelPicker = open ? 'llm' : null"
              @select="selectModel('llm', $event)"
              @pull="(model, selectAfterPull) => pullModel('llm', model, selectAfterPull)"
              @delete="deleteModel"
            />

            <ModelSelectCard
              title="Embedding 模型"
              subtitle="Vector model"
              :model-value="aiSettings.embedModel"
              :options="embedModelOptions"
              :open="openModelPicker === 'embed'"
              :needs-pull="embedNeedsPull"
              :is-pulling="isPullingEmbed"
              :is-model-pulling="ollamaStore.isPullingModel"
              :is-model-deleting="ollamaStore.isDeletingModel"
              @update:open="(open) => openModelPicker = open ? 'embed' : null"
              @select="selectModel('embed', $event)"
              @pull="(model, selectAfterPull) => pullModel('embed', model, selectAfterPull)"
              @delete="deleteModel"
            />
          </div>

          <label class="grid gap-2 text-sm text-text-main">
            <span class="flex items-center justify-between gap-3">
              <span class="text-xs font-medium text-text-main">向量存储路径</span>
              <span class="text-[10px] text-text-subtle">Vector store</span>
            </span>
            <input
              class="h-10 rounded-xl border border-border-soft bg-panel-soft px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent cursor-not-allowed"
              :value="aiSettings.vectorStorePath"
              spellcheck="false"
              placeholder=".looma/rag-index"
              @change="updateAiSetting('vectorStorePath', ($event.target as HTMLInputElement).value)"
              disabled
            />
            <span class="text-xs leading-5 text-text-muted">
              相对于当前工作空间的目录。修改后需要重新建立索引，旧索引不会自动转换。
            </span>
          </label>

        </div>
      </section>
      <section v-if="ollamaStore.installed" class="rounded-2xl border border-border-soft bg-panel p-4 shadow-sm">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <Database :size="15" class="text-text-muted" />
            <h2 class="text-sm font-semibold text-text-main">本地模型状态</h2>
          </div>
          <span class="text-[11px] text-text-subtle">{{ ollamaModels.length }} models</span>
          <button
            type="button"
            class="inline-flex h-8 items-center gap-2 rounded-xl border border-border-soft bg-panel-soft px-3 text-xs font-medium text-text-main transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:text-text-subtle"
            :disabled="isLoadingModels"
            @click="loadOllamaModels"
          >
            <Loader2 v-if="isLoadingModels" :size="14" class="animate-spin" />
            <RefreshCw v-else :size="14" />
            <span>刷新模型</span>
          </button>
        </div>

        <div
          v-if="ollamaError"
          class="rounded-2xl border border-danger/30 bg-danger/10 p-3 text-sm leading-6 text-danger"
        >
          <div class="mb-1 flex items-center gap-2 font-medium">
            <AlertCircle :size="15" />
            无法读取模型列表
          </div>
          <p class="text-xs leading-5">{{ ollamaError }}</p>
        </div>
        <div
          v-else
          class="rounded-2xl border border-border-soft bg-panel-soft p-3"
        >
          <div class="mb-2 flex items-center justify-between gap-3">
            <span class="text-xs font-medium text-text-main">本地服务状态</span>
            <span
              class="inline-flex items-center gap-1 text-[11px]"
              :class="isLoadingModels ? 'text-text-muted' : 'text-success'"
            >
              <Loader2 v-if="isLoadingModels" :size="12" class="animate-spin" />
              <CheckCircle2 v-else :size="12" />
              {{ isLoadingModels ? '读取中' : '已连接' }}
            </span>
          </div>
          <p class="text-xs leading-5 text-text-muted">
            已安装模型：{{ ollamaModels.length ? ollamaModels.join('、') : (isLoadingModels ? '正在读取...' : '暂无可用列表') }}
          </p>
        </div>
      </section>
      <section class="rounded-2xl border border-border-soft bg-panel p-4 shadow-sm">
        <div class="flex items-start gap-3">
          <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-panel-soft text-text-muted">
            <ShieldCheck :size="16" />
          </span>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-text-main">隐私与索引提示</div>
            <p class="mt-1 text-xs leading-5 text-text-muted">
              使用 Ollama 时，请求默认保留在本地。修改嵌入模型或向量存储路径后，需要重新建立工作空间索引。
            </p>
          </div>
        </div>
      </section>
    </div>

  </div>
</template>
