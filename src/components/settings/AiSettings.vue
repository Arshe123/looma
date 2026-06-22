<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '@/store/settings'
import { useOllamaStore } from '@/store/ollama'
import type { AppSettings } from '@/common/util/app-settings'
import ModelSelectCard, { type ModelOption } from './ModelSelectCard.vue'
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
} from 'lucide-vue-next'

type ModelKind = 'llm' | 'embed'
type AiSettings = AppSettings['ai']
type AiSettingKey =
  | keyof AiSettings
  | 'llmProvider'
  | 'llmBaseUrl'
  | 'llmApiKey'
  | 'llmModel'
  | 'llmTemperature'
  | 'llmMaxTokens'
  | 'embedProvider'
  | 'embedBaseUrl'
  | 'embedApiKey'
  | 'embedModel'
  | 'embedDimension'

type ProviderValue = AiSettings['chat']['provider']

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

const providerOptions: Array<{ value: ProviderValue; label: string }> = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: '通义千问' },
  { value: 'custom', label: '自定义 HTTP API' },
]

const indexingModeOptions: Array<{ value: AiSettings['indexingMode']; label: string }> = [
  { value: 'manual', label: '手动' },
  { value: 'incremental', label: '自动增量' },
  { value: 'idle', label: '应用空闲时自动' },
]

const settingsStore = useSettingsStore()
const ollamaStore = useOllamaStore()
const ollamaModels = ref<string[]>([])
const isLoadingModels = ref(false)
const ollamaError = ref('')
const openModelPicker = ref<ModelKind | null>(null)

const aiSettings = computed(() => settingsStore.aiSettings)
const llmBaseUrl = computed(() => aiSettings.value.chat.baseUrl || 'http://127.0.0.1:11434')
const embedBaseUrl = computed(() => aiSettings.value.embedding.baseUrl || llmBaseUrl.value)
const llmNeedsPull = computed(() => aiSettings.value.chat.provider === 'ollama' && Boolean(aiSettings.value.chat.model && !ollamaModels.value.includes(aiSettings.value.chat.model)))
const embedNeedsPull = computed(() => aiSettings.value.embedding.provider === 'ollama' && Boolean(aiSettings.value.embedding.model && !ollamaModels.value.includes(aiSettings.value.embedding.model)))
const installedModelSet = computed(() => new Set(ollamaModels.value))
const isPullingLlm = computed(() => ollamaStore.isPullingModel(aiSettings.value.chat.model))
const isPullingEmbed = computed(() => ollamaStore.isPullingModel(aiSettings.value.embedding.model))

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

const llmModelOptions = computed(() => buildModelOptions(defaultLlmModels, aiSettings.value.chat.model))
const embedModelOptions = computed(() => buildModelOptions(defaultEmbedModels, aiSettings.value.embedding.model))

const showInfo = async (title: string, message: string, detail?: string) => {
  await window.electronAPI.app.showMessageBox({
    type: 'info',
    buttons: ['知道了'],
    defaultId: 0,
    title,
    message,
    detail,
  })
}

const loadOllamaModels = async () => {
  if (isLoadingModels.value) return
  isLoadingModels.value = true
  ollamaError.value = ''
  try {
    const result = await window.electronAPI.ollama.listModels(llmBaseUrl.value)
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

const updateTopLevelSetting = async <K extends keyof AiSettings>(key: K, value: AiSettings[K]) => {
  await settingsStore.setAiSettings({ [key]: value } as Partial<AiSettings>)
}

const updateChatSetting = async <K extends keyof AiSettings['chat']>(key: K, value: AiSettings['chat'][K]) => {
  await settingsStore.setAiSettings({
    chat: {
      ...aiSettings.value.chat,
      [key]: value,
    },
  })
  if (key === 'baseUrl' || key === 'provider') {
    await ollamaStore.checkInstalled(llmBaseUrl.value)
    if (ollamaStore.installed) await loadOllamaModels()
  }
}

const updateEmbeddingSetting = async <K extends keyof AiSettings['embedding']>(key: K, value: AiSettings['embedding'][K]) => {
  await settingsStore.setAiSettings({
    embedding: {
      ...aiSettings.value.embedding,
      [key]: value,
    },
  })
}

const updateTextSetting = (key: AiSettingKey, event: Event) => {
  const value = (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value
  if (key === 'llmProvider') return updateChatSetting('provider', value as AiSettings['chat']['provider'])
  if (key === 'llmBaseUrl') return updateChatSetting('baseUrl', value)
  if (key === 'llmApiKey') return updateChatSetting('apiKey', value)
  if (key === 'llmModel') return updateChatSetting('model', value)
  if (key === 'llmTemperature') return updateChatSetting('temperature', Number(value))
  if (key === 'llmMaxTokens') return updateChatSetting('maxTokens', value.trim() ? Number(value) : undefined)
  if (key === 'embedProvider') return updateEmbeddingSetting('provider', value as AiSettings['embedding']['provider'])
  if (key === 'embedBaseUrl') return updateEmbeddingSetting('baseUrl', value)
  if (key === 'embedApiKey') return updateEmbeddingSetting('apiKey', value)
  if (key === 'embedModel') return updateEmbeddingSetting('model', value)
  if (key === 'embedDimension') return updateEmbeddingSetting('dimension', value.trim() ? Number(value) : undefined)
  return updateTopLevelSetting(key as keyof AiSettings, value as never)
}

const toggleAiSetting = (key: 'enableAiTimeline' | 'enableSourceCitation' | 'localFirstMode') => {
  updateTopLevelSetting(key, !aiSettings.value[key])
}

const testAllSettings = async () => {
  if (aiSettings.value.chat.provider === 'ollama' || aiSettings.value.embedding.provider === 'ollama') {
    await loadOllamaModels()
    if (ollamaError.value) {
      await showInfo('配置测试未通过', '当前无法读取本地模型列表。', ollamaError.value)
      return
    }
  }
  await showInfo(
    '配置测试完成',
    'AI 设置已通过本地表单校验；Ollama 模型列表检测已完成。',
    `对话模型：${aiSettings.value.chat.model}\n向量模型：${aiSettings.value.embedding.model}`,
  )
}

const downloadOllama = async () => {
  await ollamaStore.downloadInstaller(llmBaseUrl.value)
}

const closeModelPicker = () => {
  openModelPicker.value = null
}

const selectModel = async (kind: ModelKind, model: string) => {
  if (kind === 'llm') await updateChatSetting('model', model)
  else await updateEmbeddingSetting('model', model)
  closeModelPicker()
}

const pullModel = async (kind: ModelKind, targetModel?: string, selectAfterPull = true) => {
  const model = (targetModel || (kind === 'llm' ? aiSettings.value.chat.model : aiSettings.value.embedding.model)).trim()
  if (!model.trim()) return

  const title = kind === 'llm' ? '下载对话模型' : '下载向量模型'
  ollamaError.value = ''
  if (selectAfterPull) {
    if (kind === 'llm') await updateChatSetting('model', model)
    else await updateEmbeddingSetting('model', model)
  }
  closeModelPicker()
  await ollamaStore.pullModel(kind === 'llm' ? llmBaseUrl.value : embedBaseUrl.value, model, title)
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
  const result = await ollamaStore.deleteModel(llmBaseUrl.value, name)
  if (!result.success) {
    ollamaError.value = result.error || `删除模型 ${name} 失败。`
  }
}

onMounted(async () => {
  const installed = await ollamaStore.checkInstalled(llmBaseUrl.value)
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
  <div class="mx-auto flex w-full max-w-5xl flex-col gap-5 px-2 py-1">
    <div class="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div>
        <div class="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-subtle">AI Settings</div>
        <h1 class="mt-1 text-xl font-bold tracking-[-0.03em] text-text-main">AI 设置</h1>
        <p class="mt-1 text-sm leading-6 text-text-muted">
          按通用设置、提示词、对话模型、向量模型分节管理。对话模型和向量模型拥有独立的 Provider 与 API 接入配置。
        </p>
        <p class="text-xs leading-5 text-text-muted">
          已安装 Ollama 模型：{{ ollamaModels.length ? ollamaModels.join('、') : (isLoadingModels ? '正在读取...' : '暂无可用列表') }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-if="!ollamaStore.isChecking && !ollamaStore.installed"
          type="button"
          class="inline-flex h-8 items-center justify-center gap-2 rounded-xl bg-accent px-3 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-accent-soft disabled:text-text-muted"
          :disabled="ollamaStore.isDownloading"
          @click="downloadOllama"
        >
          <Loader2 v-if="ollamaStore.isDownloading" :size="13" class="animate-spin" />
          <Download v-else :size="13" />
          {{ ollamaStore.isDownloading ? '下载中' : '下载 Ollama' }}
        </button>
        <button
          type="button"
          class="inline-flex h-8 items-center justify-center gap-2 rounded-xl border border-border-soft bg-panel-soft px-3 text-xs font-medium text-text-main transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:text-text-subtle"
          :disabled="isLoadingModels"
          @click="testAllSettings"
        >
          <Loader2 v-if="isLoadingModels" :size="13" class="animate-spin" />
          <RefreshCw v-else :size="13" />
          测试全部配置
        </button>
      </div>
    </div>

    <div class="grid gap-0">
      <section class="grid grid-cols-[2.4rem_minmax(0,1fr)] gap-3 border-b border-border-soft py-5 first:pt-0">
        <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-panel-soft text-sm font-bold text-text-muted">01</div>
        <div class="grid min-w-0 gap-4">
          <div class="flex flex-wrap items-start gap-3">
            <div>
              <h2 class="text-base font-bold text-text-main">通用设置</h2>
              <p class="mt-1 text-xs leading-5 text-text-muted">控制索引位置、AI 行为记录和隐私策略。</p>
            </div>
          </div>

          <div class="grid gap-4">
            <label class="grid gap-2 text-sm text-text-main">
              <span class="text-xs font-semibold text-text-main">向量存储位置</span>
              <input
                class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent"
                :value="aiSettings.vectorStorePath"
                spellcheck="false"
                placeholder=".looma/rag-index"
                @change="updateTextSetting('vectorStorePath', $event)"
              />
              <span class="text-xs leading-5 text-text-muted">修改后需要重新建立索引，旧索引不会自动转换。</span>
            </label>

            <label class="grid gap-2 text-sm text-text-main">
              <span class="text-xs font-semibold text-text-main">索引更新策略</span>
              <select
                class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none focus:border-accent"
                :value="aiSettings.indexingMode"
                @change="updateTextSetting('indexingMode', $event)"
              >
                <option v-for="option in indexingModeOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
              <span class="text-xs leading-5 text-text-muted">手动更稳，增量或空闲更新更适合频繁编辑。</span>
            </label>
          </div>

          <div class="grid gap-4">
            <button
              type="button"
              class="flex min-h-20 items-start justify-between gap-4 rounded-2xl border border-border-soft bg-panel-soft p-4 text-left transition-colors hover:bg-accent-soft/40"
              @click="toggleAiSetting('enableAiTimeline')"
            >
              <span>
                <span class="block text-sm font-bold text-text-main">启用 AI 时间线</span>
                <span class="mt-1 block text-xs leading-5 text-text-muted">在回答下方折叠展示检索、模型调用和工具步骤。</span>
              </span>
              <span class="relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors" :class="aiSettings.enableAiTimeline ? 'bg-text-main' : 'bg-border-soft'">
                <span class="absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform" :class="aiSettings.enableAiTimeline ? 'left-6' : 'left-1'" />
              </span>
            </button>

            <button
              type="button"
              class="flex min-h-20 items-start justify-between gap-4 rounded-2xl border border-border-soft bg-panel-soft p-4 text-left transition-colors hover:bg-accent-soft/40"
              @click="toggleAiSetting('enableSourceCitation')"
            >
              <span>
                <span class="block text-sm font-bold text-text-main">来源引用</span>
                <span class="mt-1 block text-xs leading-5 text-text-muted">回答时附带引用笔记、文件和片段来源。</span>
              </span>
              <span class="relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors" :class="aiSettings.enableSourceCitation ? 'bg-text-main' : 'bg-border-soft'">
                <span class="absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform" :class="aiSettings.enableSourceCitation ? 'left-6' : 'left-1'" />
              </span>
            </button>
          </div>
        </div>
      </section>

      <section class="grid grid-cols-[2.4rem_minmax(0,1fr)] gap-3 border-b border-border-soft py-5">
        <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-panel-soft text-sm font-bold text-text-muted">02</div>
        <div class="grid min-w-0 gap-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 class="text-base font-bold text-text-main">对话模型设置</h2>
              <p class="mt-1 text-xs leading-5 text-text-muted">生成回答使用的模型，独立配置 Provider、API Key 和参数。</p>
            </div>
            <span
              class="rounded-full border px-3 py-1 text-[11px] font-medium"
              :class="llmNeedsPull ? 'border-danger/20 bg-danger/10 text-danger' : 'border-success/20 bg-success/10 text-success'"
            >
              {{ llmNeedsPull ? '模型未下载' : 'Chat OK' }}
            </span>
          </div>

          <label class="grid gap-2 text-sm text-text-main">
            <span class="text-xs font-semibold text-text-main">Provider</span>
            <select
              class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none focus:border-accent"
              :value="aiSettings.chat.provider"
              @change="updateTextSetting('llmProvider', $event)"
            >
              <option v-for="option in providerOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>

          <label class="grid gap-2 text-sm text-text-main" v-if="aiSettings.chat.provider !== 'ollama'">
            <span class="text-xs font-semibold text-text-main">API Key</span>
            <input
              class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent"
              :value="aiSettings.chat.apiKey"
              placeholder="sk-... / 自定义密钥"
              spellcheck="false"
              type="password"
              @change="updateTextSetting('llmApiKey', $event)"
            />
          </label>

          <label class="grid gap-2 text-sm text-text-main">
            <span class="text-xs font-semibold text-text-main">Base URL</span>
            <input
              class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent"
              :value="llmBaseUrl"
              spellcheck="false"
              placeholder="http://127.0.0.1:11434 / https://api.example.com/v1"
              @change="updateTextSetting('llmBaseUrl', $event)"
            />
          </label>

          <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-4">
            <label class="grid gap-2 text-sm text-text-main">
              <span class="text-xs font-semibold text-text-main">Temperature</span>
              <input
                class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent"
                :value="aiSettings.chat.temperature"
                placeholder="0.7"
                type="number"
                min="0"
                max="2"
                step="0.1"
                @change="updateTextSetting('llmTemperature', $event)"
              />
            </label>
            <label class="grid gap-2 text-sm text-text-main">
              <span class="text-xs font-semibold text-text-main">Max Tokens</span>
              <input
                class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent"
                :value="aiSettings.chat.maxTokens"
                placeholder="留空为默认"
                type="number"
                min="1"
                step="1"
                @change="updateTextSetting('llmMaxTokens', $event)"
              />
            </label>
          </div>

          <ModelSelectCard
            title="Model"
            subtitle="Chat model"
            :model-value="aiSettings.chat.model"
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
        </div>
      </section>

      <section class="grid grid-cols-[2.4rem_minmax(0,1fr)] gap-3 py-5 pb-0">
        <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-panel-soft text-sm font-bold text-text-muted">03</div>
        <div class="grid min-w-0 gap-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 class="text-base font-bold text-text-main">向量模型设置</h2>
              <p class="mt-1 text-xs leading-5 text-text-muted">检索和索引用的 embedding 模型，接入方式与对话模型分开设置。</p>
            </div>
            <span
              class="rounded-full border px-3 py-1 text-[11px] font-medium"
              :class="embedNeedsPull ? 'border-danger/20 bg-danger/10 text-danger' : 'border-amber-300/70 bg-amber-50 text-amber-700'"
            >
              {{ embedNeedsPull ? '模型未下载' : '变更后需重建索引' }}
            </span>
          </div>

          <label class="grid gap-2 text-sm text-text-main">
            <span class="text-xs font-semibold text-text-main">Provider</span>
            <select
              class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none focus:border-accent"
              :value="aiSettings.embedding.provider"
              @change="updateTextSetting('embedProvider', $event)"
            >
              <option v-for="option in providerOptions" :key="option.value" :value="option.value">
                {{ option.label }} Embeddings
              </option>
            </select>
          </label>

          <label class="grid gap-2 text-sm text-text-main" v-if="aiSettings.embedding.provider !== 'ollama'">
            <span class="text-xs font-semibold text-text-main">API Key</span>
            <input
              class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent"
              :value="aiSettings.embedding.apiKey"
              placeholder="Embedding API 密钥"
              spellcheck="false"
              type="password"
              @change="updateTextSetting('embedApiKey', $event)"
            />
          </label>

          <label class="grid gap-2 text-sm text-text-main">
            <span class="text-xs font-semibold text-text-main">Embedding Base URL</span>
            <input
              class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent"
              :value="embedBaseUrl"
              spellcheck="false"
              placeholder="http://127.0.0.1:11434 / https://api.example.com/v1"
              @change="updateTextSetting('embedBaseUrl', $event)"
            />
          </label>

          <ModelSelectCard
            title="Embedding Model"
            subtitle="Vector model"
            :model-value="aiSettings.embedding.model"
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

          <label class="grid gap-2 text-sm text-text-main">
            <span class="text-xs font-semibold text-text-main">向量维度</span>
            <input
              class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent"
              :value="aiSettings.embedding.dimension"
              spellcheck="false"
              placeholder="留空为自动检测"
              type="number"
              min="1"
              step="1"
              @change="updateTextSetting('embedDimension', $event)"
            />
          </label>

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
        </div>
      </section>
    </div>
  </div>
</template>
