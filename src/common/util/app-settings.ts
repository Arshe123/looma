import { DEFAULT_INLINE_MENU_ACTION_IDS } from '../constant/MenuConst'

export type AiProvider = 'ollama' | 'openai' | 'openai-compatible' | 'deepseek' | 'qwen' | 'custom'

export interface AppSettings {
  inlineMenu: {
    items: string[]
  }
  ai: {
    chat: {
      provider: AiProvider
      model: string
      baseUrl?: string
      apiKey?: string
      temperature?: number
      maxTokens?: number
    }
    embedding: {
      provider: AiProvider
      model: string
      baseUrl?: string
      apiKey?: string
      dimension?: number
    }
    vectorStorePath: string
    indexingMode: 'manual' | 'incremental' | 'idle'
    enableAiTimeline: boolean
    enableSourceCitation: boolean
    localFirstMode: boolean
  }
}

const defaultInlineMenuItems = (): string[] =>
  [...DEFAULT_INLINE_MENU_ACTION_IDS]

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

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

export const defaultAppSettings: AppSettings = {
  inlineMenu: {
    items: defaultInlineMenuItems(),
  },
  ai: {
    chat: {
      provider: 'ollama',
      model: 'qwen2.5:7b',
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      apiKey: '',
      temperature: 0.7,
    },
    embedding: {
      provider: 'ollama',
      model: 'bge-m3:latest',
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      apiKey: '',
    },
    vectorStorePath: '.looma/rag-index',
    indexingMode: 'manual',
    enableAiTimeline: true,
    enableSourceCitation: true,
    localFirstMode: true,
  },
}

const normalizeAppSettingsProvider = (raw: unknown, fallback: AiProvider): AiProvider =>
  raw === 'ollama'
  || raw === 'openai'
  || raw === 'openai-compatible'
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

export const normalizeAppSettings = (value: unknown): AppSettings => {
  if (!value || typeof value !== 'object') return defaultAppSettings
  const inlineMenu = (value as { inlineMenu?: unknown }).inlineMenu
  const items = inlineMenu && typeof inlineMenu === 'object'
    ? (inlineMenu as { items?: unknown }).items
    : undefined
  const ai = (value as { ai?: unknown }).ai
  const rawAi = ai && typeof ai === 'object'
    ? ai as Record<string, unknown>
    : {}

  const rawChat = rawAi.chat && typeof rawAi.chat === 'object'
    ? rawAi.chat as Record<string, unknown>
    : {}
  const rawEmbedding = rawAi.embedding && typeof rawAi.embedding === 'object'
    ? rawAi.embedding as Record<string, unknown>
    : {}

  // 兼容旧版扁平配置字段。
  const legacyOllamaBaseUrl = normalizeNonEmptyString(rawAi.ollamaBaseUrl, DEFAULT_OLLAMA_BASE_URL)
  const legacyLlmBaseUrl = normalizeNonEmptyString(rawAi.llmBaseUrl, legacyOllamaBaseUrl)
  const legacyEmbedBaseUrl = normalizeNonEmptyString(rawAi.embedBaseUrl, legacyOllamaBaseUrl)

  const chatProvider = normalizeAppSettingsProvider(rawChat.provider ?? rawAi.llmProvider, defaultAppSettings.ai.chat.provider)
  const embeddingProvider = normalizeAppSettingsProvider(rawEmbedding.provider ?? rawAi.embedProvider, defaultAppSettings.ai.embedding.provider)

  return {
    inlineMenu: {
      items: normalizeInlineMenuItemsForSettings(items),
    },
    ai: {
      chat: {
        provider: chatProvider,
        model: normalizeNonEmptyString(rawChat.model ?? rawAi.llmModel, defaultAppSettings.ai.chat.model),
        baseUrl: normalizeOptionalString(rawChat.baseUrl ?? rawAi.llmBaseUrl, legacyLlmBaseUrl),
        apiKey: normalizeOptionalString(rawChat.apiKey ?? rawAi.llmApiKey, defaultAppSettings.ai.chat.apiKey),
        temperature: normalizeOptionalNumber(rawChat.temperature ?? rawAi.temperature, defaultAppSettings.ai.chat.temperature),
        maxTokens: normalizeOptionalNumber(rawChat.maxTokens ?? rawAi.maxTokens, defaultAppSettings.ai.chat.maxTokens),
      },
      embedding: {
        provider: embeddingProvider,
        model: normalizeNonEmptyString(rawEmbedding.model ?? rawAi.embedModel, defaultAppSettings.ai.embedding.model),
        baseUrl: normalizeOptionalString(rawEmbedding.baseUrl ?? rawAi.embedBaseUrl, legacyEmbedBaseUrl),
        apiKey: normalizeOptionalString(rawEmbedding.apiKey ?? rawAi.embedApiKey, defaultAppSettings.ai.embedding.apiKey),
        dimension: normalizeOptionalNumber(rawEmbedding.dimension ?? rawAi.embedDimensions, defaultAppSettings.ai.embedding.dimension),
      },
      vectorStorePath: normalizeNonEmptyString(rawAi.vectorStorePath, defaultAppSettings.ai.vectorStorePath),
      indexingMode: normalizeIndexingMode(rawAi.indexingMode, defaultAppSettings.ai.indexingMode),
      enableAiTimeline: normalizeBoolean(rawAi.enableAiTimeline, defaultAppSettings.ai.enableAiTimeline),
      enableSourceCitation: normalizeBoolean(rawAi.enableSourceCitation, defaultAppSettings.ai.enableSourceCitation),
      localFirstMode: normalizeBoolean(rawAi.localFirstMode, defaultAppSettings.ai.localFirstMode),
    },
  }
}
