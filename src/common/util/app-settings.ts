import { DEFAULT_INLINE_MENU_ACTION_IDS } from '../constant/MenuConst'

export interface AppSettings {
  inlineMenu: {
    items: string[]
  }
  ai: {
    provider: 'ollama'
    ollamaBaseUrl: string
    llmProvider: 'ollama' | 'openai-compatible' | 'custom'
    llmBaseUrl: string
    llmApiKey: string
    llmModel: string
    embedProvider: 'ollama' | 'openai-compatible' | 'custom'
    embedBaseUrl: string
    embedApiKey: string
    embedModel: string
    embedDimensions: string
    vectorStorePath: string
    indexingMode: 'manual' | 'incremental' | 'idle'
    enableAiTimeline: boolean
    enableSourceCitation: boolean
    localFirstMode: boolean
  }
}

const defaultInlineMenuItems = (): string[] =>
  [...DEFAULT_INLINE_MENU_ACTION_IDS]

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
    provider: 'ollama',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    llmProvider: 'ollama',
    llmBaseUrl: 'http://127.0.0.1:11434',
    llmApiKey: '',
    llmModel: 'qwen2.5:7b',
    embedProvider: 'ollama',
    embedBaseUrl: 'http://127.0.0.1:11434',
    embedApiKey: '',
    embedModel: 'bge-m3:latest',
    embedDimensions: '自动检测',
    vectorStorePath: '.looma/rag-index',
    indexingMode: 'manual',
    enableAiTimeline: true,
    enableSourceCitation: true,
    localFirstMode: true,
  },
}

export const normalizeAppSettings = (value: unknown): AppSettings => {
  if (!value || typeof value !== 'object') return defaultAppSettings
  const inlineMenu = (value as { inlineMenu?: unknown }).inlineMenu
  const items = inlineMenu && typeof inlineMenu === 'object'
    ? (inlineMenu as { items?: unknown }).items
    : undefined
  const ai = (value as { ai?: unknown }).ai
  const rawAi = ai && typeof ai === 'object'
    ? ai as Partial<Record<keyof AppSettings['ai'], unknown>>
    : {}
  const normalizeNonEmptyString = (raw: unknown, fallback: string) =>
    typeof raw === 'string' && raw.trim() ? raw.trim() : fallback
  const normalizeString = (raw: unknown, fallback: string) =>
    typeof raw === 'string' ? raw : fallback
  const normalizeBoolean = (raw: unknown, fallback: boolean) =>
    typeof raw === 'boolean' ? raw : fallback
  const normalizeProvider = (raw: unknown, fallback: AppSettings['ai']['llmProvider']) =>
    raw === 'ollama' || raw === 'openai-compatible' || raw === 'custom' ? raw : fallback
  const normalizeIndexingMode = (raw: unknown, fallback: AppSettings['ai']['indexingMode']) =>
    raw === 'manual' || raw === 'incremental' || raw === 'idle' ? raw : fallback

  const legacyBaseUrl = normalizeNonEmptyString(rawAi.ollamaBaseUrl, defaultAppSettings.ai.ollamaBaseUrl)
  const llmBaseUrl = normalizeNonEmptyString(rawAi.llmBaseUrl, legacyBaseUrl)
  const embedBaseUrl = normalizeNonEmptyString(rawAi.embedBaseUrl, legacyBaseUrl)

  return {
    inlineMenu: {
      items: normalizeInlineMenuItemsForSettings(items),
    },
    ai: {
      provider: 'ollama',
      ollamaBaseUrl: llmBaseUrl,
      llmProvider: normalizeProvider(rawAi.llmProvider, defaultAppSettings.ai.llmProvider),
      llmBaseUrl,
      llmApiKey: normalizeString(rawAi.llmApiKey, defaultAppSettings.ai.llmApiKey),
      llmModel: normalizeNonEmptyString(rawAi.llmModel, defaultAppSettings.ai.llmModel),
      embedProvider: normalizeProvider(rawAi.embedProvider, defaultAppSettings.ai.embedProvider),
      embedBaseUrl,
      embedApiKey: normalizeString(rawAi.embedApiKey, defaultAppSettings.ai.embedApiKey),
      embedModel: normalizeNonEmptyString(rawAi.embedModel, defaultAppSettings.ai.embedModel),
      embedDimensions: normalizeNonEmptyString(rawAi.embedDimensions, defaultAppSettings.ai.embedDimensions),
      vectorStorePath: normalizeNonEmptyString(rawAi.vectorStorePath, defaultAppSettings.ai.vectorStorePath),
      indexingMode: normalizeIndexingMode(rawAi.indexingMode, defaultAppSettings.ai.indexingMode),
      enableAiTimeline: normalizeBoolean(rawAi.enableAiTimeline, defaultAppSettings.ai.enableAiTimeline),
      enableSourceCitation: normalizeBoolean(rawAi.enableSourceCitation, defaultAppSettings.ai.enableSourceCitation),
      localFirstMode: normalizeBoolean(rawAi.localFirstMode, defaultAppSettings.ai.localFirstMode),
    },
  }
}
