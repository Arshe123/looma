<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '@/renderer/stores/settings'
import { useOllamaStore } from '@/renderer/stores/ollama'
import {
  getDefaultChatProviderConfig,
  getDefaultEmbeddingProviderConfig,
  type AgentTool,
  type AiProvider,
  type AppSettings,
} from '@/shared/utils/app-settings'
import ModelSelectCard, { type ModelOption } from './ModelSelectCard.vue'
import {
  AlertCircle,
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

type ProviderValue = AiProvider

type ProviderModelCatalog = Record<AiProvider, string[]>

const defaultLlmModelsByProvider: ProviderModelCatalog = {
  ollama: ['qwen2.5:7b', 'qwen2.5:3b', 'llama3.1:8b', 'deepseek-r1:7b'],
  openai: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  qwen: ['qwen3.7-plus'],
  custom: [],
}

const defaultEmbedModelsByProvider: ProviderModelCatalog = {
  ollama: ['bge-m3:latest', 'nomic-embed-text:latest', 'mxbai-embed-large:latest'],
  openai: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
  deepseek: [],
  qwen: ['text-embedding-v4', 'text-embedding-v3', 'text-embedding-async-v2'],
  custom: [],
}

const modelMetadata: Record<string, { desc: string; size?: string }> = {
  'qwen2.5:7b': { desc: '通用中文能力较好，适合日常笔记问答', size: '约 4.7 GB' },
  'qwen2.5:3b': { desc: '响应更轻量，适合低配置设备和快速任务', size: '约 2.0 GB' },
  'llama3.1:8b': { desc: '英文能力较好，适合通用对话和写作', size: '约 4.9 GB' },
  'deepseek-r1:7b': { desc: '偏推理任务，适合分析和步骤拆解', size: '约 4.7 GB' },
  'bge-m3:latest': { desc: '多语言向量模型，适合 RAG 检索', size: '约 1.2 GB' },
  'nomic-embed-text:latest': { desc: '文本向量模型，适合本地知识库检索', size: '约 274 MB' },
  'mxbai-embed-large:latest': { desc: '高质量嵌入模型，适合语义检索', size: '约 670 MB' },
  'gpt-4o-mini': { desc: 'OpenAI 轻量通用模型，适合日常问答和摘要' },
  'gpt-4o': { desc: 'OpenAI 通用旗舰模型，适合复杂理解和生成' },
  'gpt-4.1-mini': { desc: 'OpenAI 低延迟模型，适合工具调用和长上下文任务' },
  'gpt-4.1': { desc: 'OpenAI 高能力模型，适合复杂推理和文档处理' },
  'deepseek-v4-flash': { desc: 'DeepSeek 通用对话模型' },
  'deepseek-v4-pro': { desc: 'DeepSeek 推理模型，适合步骤化分析' },
  'qwen3.7plus': { desc: '通义千问均衡模型，适合中文知识工作' },
  'text-embedding-3-small': { desc: 'OpenAI 小型向量模型，成本低、适合常规检索' },
  'text-embedding-3-large': { desc: 'OpenAI 高质量向量模型，适合高精度语义检索' },
  'text-embedding-ada-002': { desc: 'OpenAI 旧版兼容向量模型' },
  'text-embedding-v4': { desc: '通义千问新版文本向量模型' },
  'text-embedding-v3': { desc: '通义千问文本向量模型' },
  'text-embedding-async-v2': { desc: '通义千问异步文本向量模型' },
  'bge-m3': { desc: '多语言 BGE 向量模型，常见于兼容服务' },
  'bge-large-zh-v1.5': { desc: '中文语义检索向量模型，常见于兼容服务' },
}

const providerOptions: Array<{ value: ProviderValue; label: string }> = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: '通义千问' },
  { value: 'custom', label: '自定义 HTTP API' },
]

const agentToolOptions: Array<{ value: AgentTool; label: string }> = [
  { value: 'rag_search', label: 'RAG 检索' },
  { value: 'workspace_list', label: '工作区列表' },
  { value: 'workspace_search', label: '工作区搜索' },
  { value: 'file_read', label: '文件读取' },
]

const settingsStore = useSettingsStore()
const ollamaStore = useOllamaStore()
const ollamaModels = ref<string[]>([])
const isLoadingModels = ref(false)
const ollamaError = ref('')
const openModelPicker = ref<ModelKind | null>(null)

const aiSettings = computed(() => settingsStore.aiSettings)
const llmBaseUrl = computed(() => aiSettings.value.chat.baseUrl || getDefaultChatProviderConfig(aiSettings.value.chat.provider).baseUrl || '')
const embedBaseUrl = computed(() => aiSettings.value.embedding.baseUrl || getDefaultEmbeddingProviderConfig(aiSettings.value.embedding.provider).baseUrl || '')
const isLlmOllama = computed(() => aiSettings.value.chat.provider === 'ollama')
const isEmbedOllama = computed(() => aiSettings.value.embedding.provider === 'ollama')
const llmNeedsPull = computed(() => isLlmOllama.value && Boolean(aiSettings.value.chat.model && !ollamaModels.value.includes(aiSettings.value.chat.model)))
const embedNeedsPull = computed(() => isEmbedOllama.value && Boolean(aiSettings.value.embedding.model && !ollamaModels.value.includes(aiSettings.value.embedding.model)))
const installedModelSet = computed(() => new Set(ollamaModels.value))
const isPullingLlm = computed(() => ollamaStore.isPullingModel(aiSettings.value.chat.model))
const isPullingEmbed = computed(() => ollamaStore.isPullingModel(aiSettings.value.embedding.model))

const isModelInstalled = (model: string) => installedModelSet.value.has(model)

const getProviderLabel = (provider: AiProvider) => {
  return providerOptions.find((option) => option.value === provider)?.label ?? provider
}

const getModelDescription = (model: string, provider: AiProvider) => {
  return modelMetadata[model]?.desc ?? (provider === 'ollama' ? '已安装的本地模型' : `${getProviderLabel(provider)} 模型`)
}

const getModelSize = (model: string) => {
  return modelMetadata[model]?.size ?? ''
}

const buildModelOptions = (defaults: string[], selectedModel: string, provider: AiProvider): ModelOption[] => {
  const names = new Set<string>()
  for (const model of defaults) names.add(model)
  if (provider === 'ollama') {
    for (const model of ollamaModels.value) names.add(model)
  }
  if (selectedModel) names.add(selectedModel)

  return Array.from(names).map((name) => ({
    name,
    installed: provider === 'ollama' ? isModelInstalled(name) : true,
    selected: name === selectedModel,
    desc: getModelDescription(name, provider),
    size: provider === 'ollama' ? getModelSize(name) : '',
  }))
}

const llmModelOptions = computed(() => buildModelOptions(
  defaultLlmModelsByProvider[aiSettings.value.chat.provider],
  aiSettings.value.chat.model,
  aiSettings.value.chat.provider,
))
const embedModelOptions = computed(() => buildModelOptions(
  defaultEmbedModelsByProvider[aiSettings.value.embedding.provider],
  aiSettings.value.embedding.model,
  aiSettings.value.embedding.provider,
))

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
    const baseUrls = Array.from(new Set([
      isLlmOllama.value ? llmBaseUrl.value : '',
      isEmbedOllama.value ? embedBaseUrl.value : '',
    ].filter(Boolean)))
    const result = await window.electronAPI.ollama.listModels(baseUrls[0] || 'http://127.0.0.1:11434')
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

const updateConversationContextSetting = async <K extends keyof AiSettings['conversationContext']>(key: K, value: AiSettings['conversationContext'][K]) => {
  await settingsStore.setAiSettings({
    conversationContext: {
      ...aiSettings.value.conversationContext,
      [key]: value,
    },
  })
}

const updateAgentSetting = async <K extends keyof AiSettings['agent']>(key: K, value: AiSettings['agent'][K]) => {
  await settingsStore.setAiSettings({
    agent: {
      ...aiSettings.value.agent,
      [key]: value,
    },
  })
}

const toggleAgentTool = async (tool: AgentTool, enabled: boolean) => {
  const selected = new Set(aiSettings.value.agent.enabledTools)
  if (enabled) selected.add(tool)
  else selected.delete(tool)
  await updateAgentSetting(
    'enabledTools',
    agentToolOptions.map(({ value }) => value).filter((value) => selected.has(value)),
  )
}

const updateChatSetting = async <K extends keyof AiSettings['chat']>(key: K, value: AiSettings['chat'][K]) => {
  const provider = aiSettings.value.chat.provider
  const nextChat = {
    ...aiSettings.value.chat,
    [key]: value,
  }
  await settingsStore.setAiSettings({
    chat: nextChat,
    chatProviderConfigs: {
      ...aiSettings.value.chatProviderConfigs,
      [provider]: {
        model: nextChat.model,
        baseUrl: nextChat.baseUrl,
        apiKey: nextChat.apiKey,
        temperature: nextChat.temperature,
        maxTokens: nextChat.maxTokens,
      },
    },
  })
  if (provider === 'ollama' && key === 'baseUrl') {
    await ollamaStore.checkInstalled(llmBaseUrl.value)
    if (ollamaStore.installed) await loadOllamaModels()
  }
}

const updateChatProvider = async (provider: AiProvider) => {
  const currentProvider = aiSettings.value.chat.provider
  const currentChat = aiSettings.value.chat
  const chatProviderConfigs = {
    ...aiSettings.value.chatProviderConfigs,
    [currentProvider]: {
      model: currentChat.model,
      baseUrl: currentChat.baseUrl,
      apiKey: currentChat.apiKey,
      temperature: currentChat.temperature,
      maxTokens: currentChat.maxTokens,
    },
  }
  const nextConfig = chatProviderConfigs[provider] ?? getDefaultChatProviderConfig(provider)
  await settingsStore.setAiSettings({
    chat: {
      provider,
      ...nextConfig,
    },
    chatProviderConfigs,
  })
  closeModelPicker()
  if (provider === 'ollama') {
    await ollamaStore.checkInstalled(nextConfig.baseUrl || llmBaseUrl.value)
    if (ollamaStore.installed) await loadOllamaModels()
  }
}

const updateEmbeddingSetting = async <K extends keyof AiSettings['embedding']>(key: K, value: AiSettings['embedding'][K]) => {
  const provider = aiSettings.value.embedding.provider
  const nextEmbedding = {
    ...aiSettings.value.embedding,
    [key]: value,
  }
  await settingsStore.setAiSettings({
    embedding: nextEmbedding,
    embeddingProviderConfigs: {
      ...aiSettings.value.embeddingProviderConfigs,
      [provider]: {
        model: nextEmbedding.model,
        baseUrl: nextEmbedding.baseUrl,
        apiKey: nextEmbedding.apiKey,
        dimension: nextEmbedding.dimension,
      },
    },
  })
  if (provider === 'ollama' && key === 'baseUrl') {
    await ollamaStore.checkInstalled(embedBaseUrl.value)
    if (ollamaStore.installed) await loadOllamaModels()
  }
}

const updateEmbeddingProvider = async (provider: AiProvider) => {
  const currentProvider = aiSettings.value.embedding.provider
  const currentEmbedding = aiSettings.value.embedding
  const embeddingProviderConfigs = {
    ...aiSettings.value.embeddingProviderConfigs,
    [currentProvider]: {
      model: currentEmbedding.model,
      baseUrl: currentEmbedding.baseUrl,
      apiKey: currentEmbedding.apiKey,
      dimension: currentEmbedding.dimension,
    },
  }
  const nextConfig = embeddingProviderConfigs[provider] ?? getDefaultEmbeddingProviderConfig(provider)
  await settingsStore.setAiSettings({
    embedding: {
      provider,
      ...nextConfig,
    },
    embeddingProviderConfigs,
  })
  closeModelPicker()
  if (provider === 'ollama') {
    await ollamaStore.checkInstalled(nextConfig.baseUrl || embedBaseUrl.value)
    if (ollamaStore.installed) await loadOllamaModels()
  }
}

const updateTextSetting = (key: AiSettingKey, event: Event) => {
  const value = (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value
  if (key === 'llmProvider') return updateChatProvider(value as AiProvider)
  if (key === 'llmBaseUrl') return updateChatSetting('baseUrl', value)
  if (key === 'llmApiKey') return updateChatSetting('apiKey', value)
  if (key === 'llmModel') return updateChatSetting('model', value)
  if (key === 'llmTemperature') return updateChatSetting('temperature', Number(value))
  if (key === 'llmMaxTokens') return updateChatSetting('maxTokens', value.trim() ? Number(value) : undefined)
  if (key === 'embedProvider') return updateEmbeddingProvider(value as AiProvider)
  if (key === 'embedBaseUrl') return updateEmbeddingSetting('baseUrl', value)
  if (key === 'embedApiKey') return updateEmbeddingSetting('apiKey', value)
  if (key === 'embedModel') return updateEmbeddingSetting('model', value)
  if (key === 'embedDimension') return updateEmbeddingSetting('dimension', value.trim() ? Number(value) : undefined)
  return updateTopLevelSetting(key as keyof AiSettings, value as never)
}

const validateRemoteProviderConfig = (
  section: '对话模型' | '向量模型',
  provider: AiProvider,
  baseUrl?: string,
  apiKey?: string,
  model?: string,
) => {
  if (provider === 'ollama') return []
  const errors: string[] = []
  const label = getProviderLabel(provider)
  const url = (baseUrl || '').trim()
  const key = (apiKey || '').trim()
  const modelName = (model || '').trim()
  if (!modelName) errors.push(`${section}（${label}）：请填写模型名称。`)
  if (!url) {
    errors.push(`${section}（${label}）：请填写 Base URL。`)
  } else {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push(`${section}（${label}）：Base URL 必须以 http:// 或 https:// 开头。`)
      }
    } catch {
      errors.push(`${section}（${label}）：Base URL 格式不正确。`)
    }
  }
  if (!key) errors.push(`${section}（${label}）：请填写 API Key。`)
  return errors
}

const testAllSettings = async () => {
  const errors: string[] = []
  const details: string[] = []

  if (isLlmOllama.value || isEmbedOllama.value) {
    await loadOllamaModels()
    if (ollamaError.value) {
      errors.push(`Ollama：${ollamaError.value}`)
    } else {
      details.push(`Ollama 模型列表：${ollamaModels.value.length ? ollamaModels.value.join('、') : '未读取到模型'}`)
    }
  }

  errors.push(...validateRemoteProviderConfig(
    '对话模型',
    aiSettings.value.chat.provider,
    aiSettings.value.chat.baseUrl,
    aiSettings.value.chat.apiKey,
    aiSettings.value.chat.model,
  ))
  errors.push(...validateRemoteProviderConfig(
    '向量模型',
    aiSettings.value.embedding.provider,
    aiSettings.value.embedding.baseUrl,
    aiSettings.value.embedding.apiKey,
    aiSettings.value.embedding.model,
  ))

  if (errors.length) {
    await showInfo('配置测试未通过', '请先修正模型提供商配置。', errors.join('\n'))
    return
  }

  await showInfo(
    '配置测试完成',
    'AI 设置已通过校验：Ollama 会读取本地模型列表，其他提供商检查 Base URL、API Key 和模型名称是否填写正确。',
    [
      `对话：${getProviderLabel(aiSettings.value.chat.provider)} / ${aiSettings.value.chat.model}`,
      `向量：${getProviderLabel(aiSettings.value.embedding.provider)} / ${aiSettings.value.embedding.model}`,
      ...details,
    ].join('\n'),
  )
}

const downloadOllama = async () => {
  await ollamaStore.downloadInstaller(llmBaseUrl.value || embedBaseUrl.value)
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
  const provider = kind === 'llm' ? aiSettings.value.chat.provider : aiSettings.value.embedding.provider
  if (provider !== 'ollama') return
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

const deleteModel = async (baseUrl: string, model: string) => {
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
  const result = await ollamaStore.deleteModel(baseUrl, name)
  if (!result.success) {
    ollamaError.value = result.error || `删除模型 ${name} 失败。`
  }
}

onMounted(async () => {
  if (!isLlmOllama.value && !isEmbedOllama.value) return
  const installed = await ollamaStore.checkInstalled(isLlmOllama.value ? llmBaseUrl.value : embedBaseUrl.value)
  if (installed) {
    loadOllamaModels().catch(() => {})
  }
})

watch(
  () => ollamaStore.modelListVersion,
  () => {
    if (ollamaStore.installed && (isLlmOllama.value || isEmbedOllama.value)) {
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
          按 Agent、上下文、对话模型、向量模型分节管理。对话模型和向量模型拥有独立的 Provider 与 API 接入配置。
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-if="(isLlmOllama || isEmbedOllama) && !ollamaStore.isChecking && !ollamaStore.installed"
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
      <section class="grid grid-cols-[2.4rem_minmax(0,1fr)] gap-3 border-b border-border-soft py-5">
        <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-panel-soft text-sm font-bold text-text-muted">01</div>
        <div class="grid min-w-0 gap-4">
          <div>
            <h2 class="text-base font-bold text-text-main">Agent 设置</h2>
            <p class="mt-1 text-xs leading-5 text-text-muted">设置默认运行模式、单次任务步骤上限和可用的只读工具。</p>
          </div>

          <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-4">
            <label class="grid gap-2 text-sm text-text-main">
              <span class="text-xs font-semibold text-text-main">默认模式</span>
              <select
                class="h-10 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none focus:border-accent"
                :value="aiSettings.agent.defaultMode"
                @change="updateAgentSetting('defaultMode', ($event.target as HTMLSelectElement).value as AiSettings['agent']['defaultMode'])"
              >
                <option value="rag">RAG</option>
                <option value="agent">Agent</option>
              </select>
            </label>

            <label class="grid gap-2 text-sm text-text-main">
              <span class="text-xs font-semibold text-text-main">最大步骤</span>
              <input
                class="h-10 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none focus:border-accent"
                :value="aiSettings.agent.maxSteps"
                type="number"
                min="1"
                max="50"
                step="1"
                @change="updateAgentSetting('maxSteps', Number(($event.target as HTMLInputElement).value))"
              />
            </label>
          </div>

          <fieldset class="grid gap-2">
            <legend class="mb-2 text-xs font-semibold text-text-main">启用工具</legend>
            <div class="flex flex-wrap gap-x-5 gap-y-2">
              <label
                v-for="tool in agentToolOptions"
                :key="tool.value"
                class="inline-flex items-center gap-2 text-xs text-text-main"
              >
                <input
                  class="h-4 w-4 rounded border-border-soft accent-accent"
                  type="checkbox"
                  :checked="aiSettings.agent.enabledTools.includes(tool.value)"
                  @change="toggleAgentTool(tool.value, ($event.target as HTMLInputElement).checked)"
                />
                {{ tool.label }}
              </label>
            </div>
          </fieldset>
        </div>
      </section>

      <section class="grid grid-cols-[2.4rem_minmax(0,1fr)] gap-3 border-b border-border-soft py-5">
        <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-panel-soft text-sm font-bold text-text-muted">02</div>
        <div class="grid min-w-0 gap-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 class="text-base font-bold text-text-main">对话上下文策略</h2>
              <p class="mt-1 text-xs leading-5 text-text-muted">选择对话历史的组织方式：只带固定最近轮数，或超过固定轮数后自动总结早期对话。</p>
            </div>
            <span class="rounded-full border border-accent/20 bg-accent-soft px-3 py-1 text-[11px] font-medium text-accent">
              Context Policy
            </span>
          </div>

          <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4">
            <label class="grid gap-2 text-sm text-text-main">
              <span class="text-xs font-semibold text-text-main">上下文策略</span>
              <select
                class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none focus:border-accent"
                :value="aiSettings.conversationContext.strategy"
                @change="updateConversationContextSetting('strategy', ($event.target as HTMLSelectElement).value as AiSettings['conversationContext']['strategy'])"
              >
                <option value="sliding_window">滑动窗口</option>
                <option value="summary">摘要总结</option>
              </select>
              <p class="text-xs leading-5 text-text-muted">滑动窗口只携带最近固定轮数；摘要总结会在超过固定轮数后调用 LLM 压缩更早对话。</p>
            </label>

            <label class="grid gap-2 text-sm text-text-main">
              <span class="text-xs font-semibold text-text-main">对话轮数</span>
              <input
                class="h-11 rounded-xl border border-border-soft bg-panel px-3 text-sm text-text-main outline-none placeholder:text-text-subtle focus:border-accent"
                :value="aiSettings.conversationContext.recentTurns"
                type="number"
                min="0"
                max="50"
                step="1"
                @change="updateConversationContextSetting('recentTurns', Number(($event.target as HTMLInputElement).value))"
              />
              <p class="text-xs leading-5 text-text-muted">设置最近多少轮用户提问及对应回答原样加入对话历史；摘要总结模式超过该轮数后压缩更早对话。</p>
            </label>
          </div>
        </div>
      </section>

      <section class="grid grid-cols-[2.4rem_minmax(0,1fr)] gap-3 border-b border-border-soft py-5">
        <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-panel-soft text-sm font-bold text-text-muted">03</div>
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
              {{ llmNeedsPull ? '模型未下载' : (isLlmOllama ? 'Chat OK' : 'Provider OK') }}
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
            <p class="text-xs leading-5 text-text-muted">
              {{ ( isLlmOllama ) ? `已安装 Ollama 模型：${ollamaModels.length ? ollamaModels.join('、') : (isLoadingModels ? '正在读取...' : '暂无可用列表')}` : '当前选择云端/兼容提供商：将校验 Base URL、API Key 和模型名称。' }}
            </p>
            <a
              v-if="isLlmOllama"
              href="https://ollama.com/search"
              target="_blank"
              class="text-xs text-accent hover:underline"
            >
              查看 Ollama 全部支持模型
            </a>
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

          <!-- <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-4">
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
          </div> -->

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
            :local-managed="isLlmOllama"
            :available-label="isLlmOllama ? '已安装' : '可选择'"
            :missing-label="isLlmOllama ? '未下载' : '需填写'"
            :empty-description="isLlmOllama ? '已安装的本地模型' : `${getProviderLabel(aiSettings.chat.provider)} 模型`"
            search-placeholder="搜索模型，或输入自定义模型名..."
            @update:open="(open) => openModelPicker = open ? 'llm' : null"
            @select="selectModel('llm', $event)"
            @pull="(model, selectAfterPull) => pullModel('llm', model, selectAfterPull)"
            @delete="deleteModel(aiSettings.chat.baseUrl, aiSettings.chat.model)"
          />
        </div>
      </section>

      <section class="grid grid-cols-[2.4rem_minmax(0,1fr)] gap-3 py-5 pb-0">
        <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-panel-soft text-sm font-bold text-text-muted">04</div>
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
              {{ embedNeedsPull ? '模型未下载' : (isEmbedOllama ? '变更后需重建索引' : 'Provider OK') }}
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
            <p class="text-xs leading-5 text-text-muted">
              {{ ( isEmbedOllama ) ? `已安装 Ollama 模型：${ollamaModels.length ? ollamaModels.join('、') : (isLoadingModels ? '正在读取...' : '暂无可用列表')}` : '当前选择云端/兼容提供商：将校验 Base URL、API Key 和模型名称。' }}
            </p>
            <a
              v-if="isLlmOllama"
              href="https://ollama.com/search"
              target="_blank"
              class="text-xs text-accent hover:underline"
            >
              查看 Ollama 全部支持模型
            </a>
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
            :local-managed="isEmbedOllama"
            :available-label="isEmbedOllama ? '已安装' : '可选择'"
            :missing-label="isEmbedOllama ? '未下载' : '需填写'"
            :empty-description="isEmbedOllama ? '已安装的本地模型' : `${getProviderLabel(aiSettings.embedding.provider)} 模型`"
            search-placeholder="搜索模型，或输入自定义模型名..."
            @update:open="(open) => openModelPicker = open ? 'embed' : null"
            @select="selectModel('embed', $event)"
            @pull="(model, selectAfterPull) => pullModel('embed', model, selectAfterPull)"
            @delete="deleteModel(aiSettings.embedding.baseUrl, aiSettings.embedding.model)"
          />

          <!-- <label class="grid gap-2 text-sm text-text-main">
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
          </label> -->

          <div
            v-if="ollamaError && (isLlmOllama || isEmbedOllama)"
            class="rounded-2xl border border-danger/30 bg-danger/10 p-3 text-sm leading-6 text-danger"
          >
            <div class="mb-1 flex items-center gap-2 font-medium">
              <AlertCircle :size="15" />
              错误
            </div>
            <p class="text-xs leading-5">{{ ollamaError }}</p>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
