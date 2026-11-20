import { DEFAULT_INLINE_MENU_ACTION_IDS } from '../constants/MenuConst'
import {
  createDefaultEditorShortcutSettings,
  normalizeEditorShortcutSettings,
  type EditorShortcutSettings,
} from './editor-shortcuts'
import {
  createDefaultAppShortcutSettings,
  normalizeAppShortcutSettings,
  type AppShortcutSettings,
} from './app-shortcuts'
import { DEFAULT_RICH_TEXT_ZOOM, normalizeRichTextZoom } from './rich-text-zoom'
import { DEFAULT_FONT_PRESET, normalizeFontPreset, type FontPreset } from './font-presets'

export type AiProvider = 'ollama' | 'openai' | 'deepseek' | 'qwen' | 'custom'

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256 * 1024

export type ChatContextLimits = {
  contextWindowTokens: number
  maxInputTokens?: number
  maxOutputTokens?: number
}

export type ChatModelContext = {
  overrideTokens?: number
  discovered?: Partial<ChatContextLimits>
}

export type ChatModelContextPatch = {
  overrideTokens?: number | null
  discovered?: Partial<ChatContextLimits> | null
}

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
  memory: {
    autoMaintainUserProfile: boolean
  }
  appearance: {
    fontPreset: FontPreset
  }
  inlineMenu: {
    items: string[]
    version: number
  }
  editor: {
    showLineNumbers: boolean
    richTextZoom: number
    shortcuts: EditorShortcutSettings
    appShortcuts: AppShortcutSettings
  }
  ai: {
    chat: ChatProviderConfig & {
      provider: AiProvider
      modelContext?: ChatModelContext & { key: string }
    }
    embedding: EmbeddingProviderConfig & {
      provider: AiProvider
    }
    chatProviderConfigs: ChatProviderConfigs
    chatModelContexts: Record<string, ChatModelContext>
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

const INLINE_MENU_VERSION = 2
const PREVIOUS_DEFAULT_INLINE_MENU_ACTION_IDS = [
  'h2', 'h3', 'h4', 'h5', 'h6', 'bulletList', 'orderedList',
  'taskList', 'blockquote', 'codeBlock', 'image', 'table', 'horizontalRule',
] as const

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
    appearance: { fontPreset: DEFAULT_FONT_PRESET },
    memory: { autoMaintainUserProfile: true },
    inlineMenu: {
      items: defaultInlineMenuItems(),
      version: INLINE_MENU_VERSION,
    },
    editor: {
      showLineNumbers: true,
      richTextZoom: DEFAULT_RICH_TEXT_ZOOM,
      shortcuts: createDefaultEditorShortcutSettings(),
      appShortcuts: createDefaultAppShortcutSettings(),
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
      chatModelContexts: {},
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

export const normalizeContextTokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined

export function normalizeDiscoveredChatContext(value: unknown): Partial<ChatContextLimits> | undefined {
  const raw = asRecord(value)
  const contextWindowTokens = normalizeContextTokenCount(raw.contextWindowTokens)
  const maxInputTokens = normalizeContextTokenCount(raw.maxInputTokens)
  const maxOutputTokens = normalizeContextTokenCount(raw.maxOutputTokens)
  const result: Partial<ChatContextLimits> = {}
  if (contextWindowTokens !== undefined) result.contextWindowTokens = contextWindowTokens
  if (maxInputTokens !== undefined && maxInputTokens <= (contextWindowTokens ?? Infinity)) result.maxInputTokens = maxInputTokens
  if (maxOutputTokens !== undefined && maxOutputTokens <= (contextWindowTokens ?? Infinity)) result.maxOutputTokens = maxOutputTokens
  return Object.keys(result).length ? result : undefined
}

type ChatModelIdentity = Pick<AppSettings['ai']['chat'], 'provider' | 'baseUrl' | 'model'>

export function getChatModelContextKey({ provider, baseUrl, model }: ChatModelIdentity): string {
  return JSON.stringify([provider, (baseUrl || getDefaultChatProviderConfig(provider).baseUrl || '').trim().replace(/\/+$/, ''), model.trim()])
}

export function isChatModelContextKey(key: string): boolean {
  if (!key.startsWith('[')) return false
  try {
    const parts: unknown = JSON.parse(key)
    if (!Array.isArray(parts) || parts.length !== 3) return false
    const [provider, baseUrl, model] = parts
    return aiProviders.includes(provider) && typeof baseUrl === 'string' && typeof model === 'string' && !!model
      && getChatModelContextKey({ provider, baseUrl, model }) === key
  } catch { return false }
}

export function getChatContextLimits(chat: AppSettings['ai']['chat']): ChatContextLimits {
  const context = chat.modelContext?.key === getChatModelContextKey(chat) ? chat.modelContext : undefined
  const discovered = normalizeDiscoveredChatContext(context?.discovered)
  return {
    ...discovered,
    contextWindowTokens: normalizeContextTokenCount(context?.overrideTokens) ?? discovered?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
  }
}

export const getChatContextWindowTokens = (chat: AppSettings['ai']['chat']): number =>
  getChatContextLimits(chat).contextWindowTokens

const normalizeChatModelContexts = (value: unknown): AppSettings['ai']['chatModelContexts'] => {
  const contexts: AppSettings['ai']['chatModelContexts'] = {}
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (!isChatModelContextKey(key)) continue
    const record = asRecord(raw)
    const overrideTokens = normalizeContextTokenCount(record.overrideTokens)
    const discovered = normalizeDiscoveredChatContext(record.discovered)
    if (overrideTokens !== undefined || discovered) contexts[key] = { overrideTokens, discovered }
  }
  return contexts
}

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
  const inlineMenu = asRecord((value as { inlineMenu?: unknown }).inlineMenu)
  const normalizedInlineMenuItems = normalizeInlineMenuItemsForSettings(inlineMenu.items)
  const isPreviousUntouchedDefault = inlineMenu.version === undefined
    && normalizedInlineMenuItems.length === PREVIOUS_DEFAULT_INLINE_MENU_ACTION_IDS.length
    && normalizedInlineMenuItems.every((item, index) => item === PREVIOUS_DEFAULT_INLINE_MENU_ACTION_IDS[index])
  if (isPreviousUntouchedDefault) normalizedInlineMenuItems.push('highlight')
  const editor = asRecord((value as { editor?: unknown }).editor)
  const ai = (value as { ai?: unknown }).ai
  const rawAi = asRecord(ai)

  const rawChat = asRecord(rawAi.chat)
  const rawEmbedding = asRecord(rawAi.embedding)

  const chatProvider = normalizeAppSettingsProvider(rawChat.provider, defaults.ai.chat.provider)
  const embeddingProvider = normalizeAppSettingsProvider(rawEmbedding.provider, defaults.ai.embedding.provider)

  const chatProviderConfigs = normalizeChatProviderConfigs(rawAi.chatProviderConfigs)
  const chatModelContexts = normalizeChatModelContexts(rawAi.chatModelContexts)
  const embeddingProviderConfigs = normalizeEmbeddingProviderConfigs(rawAi.embeddingProviderConfigs)

  const activeChatConfig = normalizeChatProviderConfig({
    ...chatProviderConfigs[chatProvider],
    model: rawChat.model ?? chatProviderConfigs[chatProvider].model,
    baseUrl: rawChat.baseUrl ?? chatProviderConfigs[chatProvider].baseUrl,
    apiKey: rawChat.apiKey ?? chatProviderConfigs[chatProvider].apiKey,
    temperature: rawChat.temperature ?? chatProviderConfigs[chatProvider].temperature,
    maxTokens: rawChat.maxTokens ?? chatProviderConfigs[chatProvider].maxTokens,
  }, chatProviderConfigs[chatProvider])
  chatProviderConfigs[chatProvider] = activeChatConfig
  const activeContextKey = getChatModelContextKey({ ...activeChatConfig, provider: chatProvider })
  const activeModelContext = chatModelContexts[activeContextKey]

  const activeEmbeddingConfig = normalizeEmbeddingProviderConfig({
    ...embeddingProviderConfigs[embeddingProvider],
    model: rawEmbedding.model ?? embeddingProviderConfigs[embeddingProvider].model,
    baseUrl: rawEmbedding.baseUrl ?? embeddingProviderConfigs[embeddingProvider].baseUrl,
    apiKey: rawEmbedding.apiKey ?? embeddingProviderConfigs[embeddingProvider].apiKey,
    dimension: rawEmbedding.dimension ?? embeddingProviderConfigs[embeddingProvider].dimension,
  }, embeddingProviderConfigs[embeddingProvider])
  embeddingProviderConfigs[embeddingProvider] = activeEmbeddingConfig

  return {
    appearance: {
      fontPreset: normalizeFontPreset(asRecord((value as { appearance?: unknown }).appearance).fontPreset),
    },
    memory: {
      autoMaintainUserProfile: normalizeBoolean(asRecord((value as { memory?: unknown }).memory).autoMaintainUserProfile, true),
    },
    inlineMenu: {
      items: normalizedInlineMenuItems,
      version: INLINE_MENU_VERSION,
    },
    editor: {
      showLineNumbers: normalizeBoolean(editor.showLineNumbers, defaults.editor.showLineNumbers),
      richTextZoom: normalizeRichTextZoom(editor.richTextZoom),
      shortcuts: normalizeEditorShortcutSettings(editor.shortcuts),
      appShortcuts: normalizeAppShortcutSettings(editor.appShortcuts),
    },
    ai: {
      chat: {
        provider: chatProvider,
        ...activeChatConfig,
        ...(activeModelContext && { modelContext: { key: activeContextKey, ...activeModelContext } }),
      },
      embedding: {
        provider: embeddingProvider,
        ...activeEmbeddingConfig,
      },
      chatProviderConfigs,
      chatModelContexts,
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
