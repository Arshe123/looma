import type { Result } from '../../../shared/types/Result'

const RAG_BASE_URL = process.env.RAG_SERVICE_URL || 'http://127.0.0.1:8765'

type AiProvider = 'ollama' | 'openai' | 'openai-compatible' | 'deepseek' | 'qwen' | 'custom'

export interface RagSource {
  score: number | null
  text: string
  metadata: Record<string, unknown>
}

export interface RagAnswer {
  answer: string
  sources: RagSource[]
}

export interface RagIndexResult {
  status: string
  document_count?: number
  file_count?: number
  exists?: boolean
  persist_dir?: string
  embedding_model?: string
  embedding_provider?: string
  error?: string
}

export interface RagIndexStatus {
  exists: boolean
  persist_dir?: string
  error?: string
}

export interface RagTimelineOutput {
  id?: string
  type?: 'text' | 'source' | 'metric' | 'code' | 'json' | 'error'
  title?: string
  content?: string
  value?: string | number
  unit?: string
  path?: string
  metadata?: Record<string, unknown>
}

export interface RagTimelineStepPatch {
  id?: string
  stepId?: string
  title?: string
  description?: string
  detail?: string
  status?: 'pending' | 'active' | 'completed' | 'error'
  startedAt?: number
  endedAt?: number
  outputs?: RagTimelineOutput[]
}

export type RagStreamEvent =
  | ({ type: 'timeline' } & RagTimelineStepPatch & { step?: RagTimelineStepPatch })
  | { type: 'progress'; stepId: string; current: number; total?: number; message?: string }
  | { type: 'delta'; text: string; content?: string }
  | { type: 'sources'; sources: RagSource[] }
  | { type: 'done'; result?: RagIndexResult; status?: string; document_count?: number; file_count?: number; exists?: boolean; persist_dir?: string }
  | { type: 'error'; error: string; message?: string; stepId?: string }

export interface RagChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  name?: string
}

export interface RagRequestStats {
  history_messages: number
  history_token_estimate: number
  question_token_estimate: number
  total_token_estimate: number
}

export interface AISettings {
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
}

type RagRequestSettings = AISettings & {
  vectorStorePath?: string
}

interface AIService {
  health(): Promise<Result<{ status: string; service: string }>>

  getIndexStatus(workspacePath: string, aiSettings: RagRequestSettings): Promise<Result<RagIndexStatus>>

  streamBuildVectorIndex(
    workspacePath: string,
    aiSettings: RagRequestSettings,
    onEvent: (event: RagStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<Result<void>>

  chat(workspacePath: string, question: string, aiSettings: RagRequestSettings, history?: RagChatMessage[], requestStats?: RagRequestStats): Promise<Result<RagAnswer>>

  streamAssistant(
    workspacePath: string,
    question: string,
    aiSettings: RagRequestSettings,
    history: RagChatMessage[],
    requestStats: RagRequestStats,
    onEvent: (event: RagStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<Result<void>>
}

const getVectorStorePath = (settings: RagRequestSettings) =>
  (settings.vectorStorePath || '').trim() || '.looma/rag-index'

const omitUndefined = <T extends Record<string, unknown>>(value: T): T => {
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  return Object.fromEntries(entries) as T
}

const toProviderConfig = (config: AISettings['chat'] | AISettings['embedding']) => omitUndefined({
  provider: config.provider,
  model: config.model,
  base_url: config.baseUrl,
  api_key: config.apiKey,
  temperature: 'temperature' in config ? config.temperature : undefined,
  max_tokens: 'maxTokens' in config ? config.maxTokens : undefined,
  dimension: 'dimension' in config ? config.dimension : undefined,
})

const toAiConfig = (aiSettings: AISettings) => ({
  chat: toProviderConfig(aiSettings.chat),
  embedding: toProviderConfig(aiSettings.embedding),
})

const toKnowledgeConfig = (aiSettings: RagRequestSettings) => ({
  vector_store_path: getVectorStorePath(aiSettings),
})

const toRagQueryBody = (
  workspacePath: string,
  question: string,
  aiSettings: RagRequestSettings,
  history: RagChatMessage[] = [],
  requestStats?: RagRequestStats,
) => omitUndefined({
  question,
  workspace: {
    workspace_path: workspacePath,
  },
  knowledge: toKnowledgeConfig(aiSettings),
  ai_config: toAiConfig(aiSettings),
  history,
  request_stats: requestStats,
})

const toIndexBody = (workspacePath: string, aiSettings: RagRequestSettings) => ({
  workspace: {
    workspace_path: workspacePath,
  },
  knowledge: toKnowledgeConfig(aiSettings),
  ai_config: toAiConfig(aiSettings),
})

const postJson = async <T>(path: string, body: unknown): Promise<Result<T>> => {
  try {
    const response = await fetch(`${RAG_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await response.json().catch(() => null)
    if (!response.ok) {
      return { success: false, error: data?.detail || `RAG 服务请求失败: HTTP ${response.status}` }
    }
    return { success: true, data: data as T }
  } catch (error: any) {
    return { success: false, error: `无法连接 RAG 服务: ${error?.message ?? String(error)}` }
  }
}

const streamNdjson = async <T>(
  path: string,
  body: unknown,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
): Promise<Result<void>> => {
  try {
    const response = await fetch(`${RAG_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const data = await response.json().catch(() => null)
      return { success: false, error: data?.detail || `RAG 服务请求失败: HTTP ${response.status}` }
    }

    if (!response.body) {
      return { success: false, error: 'RAG 服务未返回可读取的流。' }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const parseLine = (line: string): Result<T> => {
      try {
        return { success: true, data: JSON.parse(line) as T }
      } catch (error: any) {
        return {
          success: false,
          error: `RAG 流数据解析失败: ${error?.message ?? String(error)}`,
        }
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        const parsed = parseLine(line)
        if (!parsed.success) return { success: false, error: parsed.error }
        onEvent(parsed.data)
      }
    }

    buffer += decoder.decode()
    const finalLine = buffer.trim()
    if (finalLine) {
      const parsed = parseLine(finalLine)
      if (!parsed.success) return { success: false, error: parsed.error }
      onEvent(parsed.data)
    }

    return { success: true }
  } catch (error: any) {
    if (error?.name === 'AbortError') return { success: true }
    return { success: false, error: `无法连接 RAG 服务: ${error?.message ?? String(error)}` }
  }
}

export const aiService: AIService = {
  async health(): Promise<Result<{ status: string; service: string }>> {
    try {
      const response = await fetch(`${RAG_BASE_URL}/health`)
      const data = await response.json().catch(() => null)
      if (!response.ok) return { success: false, error: `RAG 服务不可用: HTTP ${response.status}` }
      return { success: true, data }
    } catch (error: any) {
      return { success: false, error: `无法连接 RAG 服务: ${error?.message ?? String(error)}` }
    }
  },

  async getIndexStatus(workspacePath: string, aiSettings: RagRequestSettings): Promise<Result<RagIndexStatus>> {
    const result = await postJson<RagIndexStatus>('/rag/index/status', {
      workspace_path: workspacePath,
      vector_store_path: getVectorStorePath(aiSettings),
    })
    if (!result.success) return result
    if (result.data?.error) return { success: false, error: result.data.error }
    return result
  },

  async streamBuildVectorIndex(
    workspacePath: string,
    aiSettings: RagRequestSettings,
    onEvent: (event: RagStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    return streamNdjson<RagStreamEvent>('/rag/index/stream', toIndexBody(workspacePath, aiSettings), onEvent, signal)
  },

  async chat(
    workspacePath: string,
    question: string,
    aiSettings: RagRequestSettings,
    history: RagChatMessage[] = [],
    requestStats?: RagRequestStats,
  ): Promise<Result<RagAnswer>> {
    return postJson<RagAnswer>('/rag/query', toRagQueryBody(workspacePath, question, aiSettings, history, requestStats))
  },

  async streamAssistant(
    workspacePath: string,
    question: string,
    aiSettings: RagRequestSettings,
    history: RagChatMessage[],
    requestStats: RagRequestStats,
    onEvent: (event: RagStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    return streamNdjson<RagStreamEvent>('/rag/query/stream', toRagQueryBody(workspacePath, question, aiSettings, history, requestStats), onEvent, signal)
  },
}
