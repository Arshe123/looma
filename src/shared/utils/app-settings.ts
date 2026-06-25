import { DEFAULT_INLINE_MENU_ACTION_IDS } from '../constants/MenuConst'

export type AiProvider = 'ollama' | 'openai' | 'deepseek' | 'qwen' | 'custom'

export type ChatProviderConfig = {
  model: string
  baseUrl?: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
}

export type EmbeddingProviderConfig = {
  model: string
  baseUrl?: string
  apiKey?: string
  dimension?: number
}

export type ChatProviderConfigs = Record<AiProvider, ChatProviderConfig>
export type EmbeddingProviderConfigs = Record<AiProvider, EmbeddingProviderConfig>
export type ChunkingStrategy = 'fixed' | 'markdown' | 'semantic' | 'parent_child' | 'code_aware'

export interface AppSettings {
  inlineMenu: {
    items: string[]
  }
  ai: {
    chat: ChatProviderConfig & {
      provider: AiProvider
    }
    embedding: EmbeddingProviderConfig & {
      provider: AiProvider
    }
    chatProviderConfigs: ChatProviderConfigs
    embeddingProviderConfigs: EmbeddingProviderConfigs
    vectorStorePath: string
    topK: number
    chunkSize: number
    chunkOverlap: number
    chunkingStrategy: ChunkingStrategy
    indexingMode: 'manual' | 'incremental' | 'idle'
    enableAiTimeline: boolean
    enableSourceCitation: boolean
    localFirstMode: boolean
  }
}

const defaultInlineMenuItems = (): string[] =>
  [...DEFAULT_INLINE_MENU_ACTION_IDS]

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

export const aiProviders: AiProvider[] = [
  'ollama',
  'openai',
  'deepseek',
  'qwen',
  'custom',
]

export const defaultChatProviderConfigs = (): ChatProviderConfigs => ({
  ollama: {
    model: 'qwen2.5:7b',
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
    apiKey: '',
    temperature: 0.7,
  },
  openai: {
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    temperature: 0.7,
  },
  deepseek: {
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    temperature: 0.7,
  },
  qwen: {
    model: 'qwen-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    temperature: 0.7,
  },
  custom: {
    model: '',
    baseUrl: '',
    apiKey: '',
    temperature: 0.7,
  },
})

export const defaultEmbeddingProviderConfigs = (): EmbeddingProviderConfigs => ({
  ollama: {
    model: 'bge-m3:latest',
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
    apiKey: '',
  },
  openai: {
    model: 'text-embedding-3-small',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
  },
  deepseek: {
    model: '',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
  },
  qwen: {
    model: 'text-embedding-v4',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
  },
  custom: {
    model: '',
    baseUrl: '',
    apiKey: '',
  },
})

const normalizeInlineMenuItemsForSettings = (
  items: unknown,
): string[] => {
  const seen = new Set<string>()
  const normalized: string[] = []

  if (!Array.isArray(items)) return defaultInlineMenuItems()

  for (const item of items) {
    const id = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? (item as { id?: unknown }).id
        : undefined
    const isVisible = !item || typeof item !== 'object'
      ? true
      : (item as { visible?: unknown }).visible !== false

    if (typeof id !== 'string' || seen.has(id) || !isVisible) {
      continue
    }
    seen.add(id)
    normalized.push(id)
  }

  return normalized
}

const createDefaultAppSettings = (): AppSettings => {
  const chatProviderConfigs = defaultChatProviderConfigs()
  const embeddingProviderConfigs = defaultEmbeddingProviderConfigs()

  return {
    inlineMenu: {
      items: defaultInlineMenuItems(),
    },
    ai: {
      chat: {
        provider: 'ollama',
        ...chatProviderConfigs.ollama,
      },
      embedding: {
        provider: 'ollama',
        ...embeddingProviderConfigs.ollama,
      },
      chatProviderConfigs,
      embeddingProviderConfigs,
      vectorStorePath: '.looma/rag-index',
      topK: 5,
      chunkSize: 800,
      chunkOverlap: 100,
      chunkingStrategy: 'fixed',
      indexingMode: 'manual',
      enableAiTimeline: true,
      enableSourceCitation: true,
      localFirstMode: true,
    },
  }
}

export const defaultAppSettings: AppSettings = createDefaultAppSettings()

const normalizeAppSettingsProvider = (raw: unknown, fallback: AiProvider): AiProvider =>
  raw === 'ollama'
  || raw === 'openai'
  || raw === 'deepseek'
  || raw === 'qwen'
  || raw === 'custom'
    ? raw
    : fallback

const normalizeNonEmptyString = (raw: unknown, fallback: string) =>
  typeof raw === 'string' && raw.trim() ? raw.trim() : fallback

const normalizeOptionalString = (raw: unknown, fallback = '') =>
  typeof raw === 'string' ? raw.trim() : fallback

const normalizeOptionalNumber = (raw: unknown, fallback?: number) => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const normalizeBoolean = (raw: unknown, fallback: boolean) =>
  typeof raw === 'boolean' ? raw : fallback

const normalizeIndexingMode = (raw: unknown, fallback: AppSettings['ai']['indexingMode']) =>
  raw === 'manual' || raw === 'incremental' || raw === 'idle' ? raw : fallback

const normalizeChunkingStrategy = (raw: unknown, fallback: ChunkingStrategy): ChunkingStrategy =>
  raw === 'fixed'
  || raw === 'markdown'
  || raw === 'semantic'
  || raw === 'parent_child'
  || raw === 'code_aware'
    ? raw
    : fallback

const normalizeBoundedInteger = (raw: unknown, fallback: number, min: number, max: number) => {
  const parsed = normalizeOptionalNumber(raw, fallback)
  const numberValue = Number.isFinite(parsed) ? Math.round(parsed as number) : fallback
  return Math.min(max, Math.max(min, numberValue))
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}

const normalizeChatProviderConfig = (
  value: unknown,
  fallback: ChatProviderConfig,
): ChatProviderConfig => {
  const raw = asRecord(value)
  return {
    model: normalizeNonEmptyString(raw.model, fallback.model),
    baseUrl: normalizeOptionalString(raw.baseUrl ?? raw.base_url, fallback.baseUrl),
    apiKey: normalizeOptionalString(raw.apiKey ?? raw.api_key, fallback.apiKey),
    temperature: normalizeOptionalNumber(raw.temperature, fallback.temperature),
    maxTokens: normalizeOptionalNumber(raw.maxTokens ?? raw.max_tokens, fallback.maxTokens),
  }
}

const normalizeEmbeddingProviderConfig = (
  value: unknown,
  fallback: EmbeddingProviderConfig,
): EmbeddingProviderConfig => {
  const raw = asRecord(value)
  return {
    model: normalizeNonEmptyString(raw.model, fallback.model),
    baseUrl: normalizeOptionalString(raw.baseUrl ?? raw.base_url, fallback.baseUrl),
    apiKey: normalizeOptionalString(raw.apiKey ?? raw.api_key, fallback.apiKey),
    dimension: normalizeOptionalNumber(raw.dimension, fallback.dimension),
  }
}

const normalizeChatProviderConfigs = (value: unknown): ChatProviderConfigs => {
  const raw = asRecord(value)
  const defaults = defaultChatProviderConfigs()
  const normalized = { ...defaults }
  for (const provider of aiProviders) {
    normalized[provider] = normalizeChatProviderConfig(raw[provider], defaults[provider])
  }
  return normalized
}

const normalizeEmbeddingProviderConfigs = (value: unknown): EmbeddingProviderConfigs => {
  const raw = asRecord(value)
  const defaults = defaultEmbeddingProviderConfigs()
  const normalized = { ...defaults }
  for (const provider of aiProviders) {
    normalized[provider] = normalizeEmbeddingProviderConfig(raw[provider], defaults[provider])
  }
  return normalized
}

export const getDefaultChatProviderConfig = (provider: AiProvider): ChatProviderConfig =>
  defaultChatProviderConfigs()[provider]

export const getDefaultEmbeddingProviderConfig = (provider: AiProvider): EmbeddingProviderConfig =>
  defaultEmbeddingProviderConfigs()[provider]

export const normalizeAppSettings = (value: unknown): AppSettings => {
  const defaults = createDefaultAppSettings()
  if (!value || typeof value !== 'object') return defaults
  const inlineMenu = (value as { inlineMenu?: unknown }).inlineMenu
  const items = inlineMenu && typeof inlineMenu === 'object'
    ? (inlineMenu as { items?: unknown }).items
    : undefined
  const ai = (value as { ai?: unknown }).ai
  const rawAi = asRecord(ai)

  const rawChat = asRecord(rawAi.chat)
  const rawEmbedding = asRecord(rawAi.embedding)

  // 兼容旧版扁平配置字段。
  const hasLegacyOllamaBaseUrl = typeof rawAi.ollamaBaseUrl === 'string' && rawAi.ollamaBaseUrl.trim()
  const hasLegacyLlmBaseUrl = typeof rawAi.llmBaseUrl === 'string' && rawAi.llmBaseUrl.trim()
  const hasLegacyEmbedBaseUrl = typeof rawAi.embedBaseUrl === 'string' && rawAi.embedBaseUrl.trim()
  const legacyOllamaBaseUrl = normalizeNonEmptyString(rawAi.ollamaBaseUrl, DEFAULT_OLLAMA_BASE_URL)
  const legacyLlmBaseUrl = hasLegacyLlmBaseUrl || hasLegacyOllamaBaseUrl
    ? normalizeNonEmptyString(rawAi.llmBaseUrl, legacyOllamaBaseUrl)
    : undefined
  const legacyEmbedBaseUrl = hasLegacyEmbedBaseUrl || hasLegacyOllamaBaseUrl
    ? normalizeNonEmptyString(rawAi.embedBaseUrl, legacyOllamaBaseUrl)
    : undefined

  const chatProvider = normalizeAppSettingsProvider(rawChat.provider ?? rawAi.llmProvider, defaults.ai.chat.provider)
  const embeddingProvider = normalizeAppSettingsProvider(rawEmbedding.provider ?? rawAi.embedProvider, defaults.ai.embedding.provider)

  const chatProviderConfigs = normalizeChatProviderConfigs(rawAi.chatProviderConfigs)
  const embeddingProviderConfigs = normalizeEmbeddingProviderConfigs(rawAi.embeddingProviderConfigs)

  const activeChatConfig = normalizeChatProviderConfig({
    ...chatProviderConfigs[chatProvider],
    model: rawChat.model ?? rawAi.llmModel ?? chatProviderConfigs[chatProvider].model,
    baseUrl: rawChat.baseUrl ?? rawAi.llmBaseUrl ?? legacyLlmBaseUrl ?? chatProviderConfigs[chatProvider].baseUrl,
    apiKey: rawChat.apiKey ?? rawAi.llmApiKey ?? chatProviderConfigs[chatProvider].apiKey,
    temperature: rawChat.temperature ?? rawAi.temperature ?? chatProviderConfigs[chatProvider].temperature,
    maxTokens: rawChat.maxTokens ?? rawAi.maxTokens ?? chatProviderConfigs[chatProvider].maxTokens,
  }, chatProviderConfigs[chatProvider])
  chatProviderConfigs[chatProvider] = activeChatConfig

  const activeEmbeddingConfig = normalizeEmbeddingProviderConfig({
    ...embeddingProviderConfigs[embeddingProvider],
    model: rawEmbedding.model ?? rawAi.embedModel ?? embeddingProviderConfigs[embeddingProvider].model,
    baseUrl: rawEmbedding.baseUrl ?? rawAi.embedBaseUrl ?? legacyEmbedBaseUrl ?? embeddingProviderConfigs[embeddingProvider].baseUrl,
    apiKey: rawEmbedding.apiKey ?? rawAi.embedApiKey ?? embeddingProviderConfigs[embeddingProvider].apiKey,
    dimension: rawEmbedding.dimension ?? rawAi.embedDimensions ?? embeddingProviderConfigs[embeddingProvider].dimension,
  }, embeddingProviderConfigs[embeddingProvider])
  embeddingProviderConfigs[embeddingProvider] = activeEmbeddingConfig

  return {
    inlineMenu: {
      items: normalizeInlineMenuItemsForSettings(items),
    },
    ai: {
      chat: {
        provider: chatProvider,
        ...activeChatConfig,
      },
      embedding: {
        provider: embeddingProvider,
        ...activeEmbeddingConfig,
      },
      chatProviderConfigs,
      embeddingProviderConfigs,
      vectorStorePath: normalizeNonEmptyString(rawAi.vectorStorePath, defaults.ai.vectorStorePath),
      topK: normalizeBoundedInteger(rawAi.topK ?? rawAi.top_k, defaults.ai.topK, 1, 50),
      chunkSize: normalizeBoundedInteger(rawAi.chunkSize ?? rawAi.chunk_size, defaults.ai.chunkSize, 128, 8192),
      chunkOverlap: normalizeBoundedInteger(rawAi.chunkOverlap ?? rawAi.chunk_overlap, defaults.ai.chunkOverlap, 0, 2048),
      chunkingStrategy: normalizeChunkingStrategy(rawAi.chunkingStrategy ?? rawAi.chunking_strategy, defaults.ai.chunkingStrategy),
      indexingMode: normalizeIndexingMode(rawAi.indexingMode, defaults.ai.indexingMode),
      enableAiTimeline: normalizeBoolean(rawAi.enableAiTimeline, defaults.ai.enableAiTimeline),
      enableSourceCitation: normalizeBoolean(rawAi.enableSourceCitation, defaults.ai.enableSourceCitation),
      localFirstMode: normalizeBoolean(rawAi.localFirstMode, defaults.ai.localFirstMode),
    },
  }
}
