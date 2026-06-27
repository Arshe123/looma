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

export interface ChatAnswer {
  answer: string
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

export interface RagIndexSummary {
  indexed: number
  notIndexed: number
  outdated: number
  deleted: number
  failed: number
  ignored: number
}

export interface RagIndexCompatibility {
  compatible: boolean
  needRebuild: boolean
  reason: string
}

export interface RagIndexFileStatus {
  path: string
  status: 'indexed' | 'not_indexed' | 'outdated' | 'deleted' | 'failed' | 'ignored'
  contentHash?: string
  mtimeMs?: number
  size?: number
  chunkIds?: string[]
  chunkCount?: number
  lastIndexedAt?: string | null
  error?: string | null
}

export interface RagFileChunk {
  id: string
  index: number
  text: string
  textLength?: number
  metadata: Record<string, unknown>
  filePath?: string
}

export interface RagFileChunksResult {
  status: string
  path: string
  chunkCount: number
  chunks: RagFileChunk[]
  manifest?: RagIndexFileStatus | null
  persist_dir?: string
  requiresRebuild?: boolean
  error?: string
}

export interface RagIndexStatus {
  exists: boolean
  persist_dir?: string
  error?: string
  workspaceId?: string
  indexCompatible?: boolean
  needRebuild?: boolean
  compatibility?: RagIndexCompatibility
  summary?: RagIndexSummary
  files?: RagIndexFileStatus[]
  metadata?: Record<string, unknown> | null
}

export type RagIndexBuildMode = 'incremental' | 'full' | 'retry_failed'

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
  recent_turns?: number
  distant_summary_enabled?: boolean
  distant_summary_messages?: number
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

  getDetailedIndexStatus(workspacePath: string): Promise<Result<RagIndexStatus>>

  streamBuildManagedIndex(
    workspacePath: string,
    mode: RagIndexBuildMode,
    onEvent: (event: RagStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<Result<void>>

  reindexFile(workspacePath: string, path: string): Promise<Result<RagIndexResult>>

  getFileChunks(workspacePath: string, path: string): Promise<Result<RagFileChunksResult>>

  deleteFileIndex(workspacePath: string, path: string): Promise<Result<RagIndexResult>>

  deleteAllIndex(workspacePath: string): Promise<Result<RagIndexResult>>

  streamBuildVectorIndex(
    workspacePath: string,
    aiSettings: RagRequestSettings,
    onEvent: (event: RagStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<Result<void>>

  chat(workspacePath: string, question: string, aiSettings: RagRequestSettings, history?: RagChatMessage[], requestStats?: RagRequestStats): Promise<Result<RagAnswer>>

  summarizeConversation(messages: RagChatMessage[], maxChars: number, aiSettings: RagRequestSettings): Promise<Result<ChatAnswer>>

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

const omitUndefined = <T extends Record<string, unknown>>(value: T): T => {
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  return Object.fromEntries(entries) as T
}

const toRagQueryBody = (
  workspacePath: string,
  question: string,
  _aiSettings: RagRequestSettings,
  history: RagChatMessage[] = [],
  requestStats?: RagRequestStats,
) => omitUndefined({
  question,
  workspace: {
    workspace_path: workspacePath,
  },
  history,
  request_stats: requestStats,
})

const toChatRequestBody = (
  question: string,
  aiSettings: RagRequestSettings,
  history: RagChatMessage[] = [],
) => omitUndefined({
  question,
  ai_config: {
    chat: aiSettings.chat,
    embedding: aiSettings.embedding,
  },
  history,
})

const toIndexBody = (workspacePath: string, _aiSettings?: RagRequestSettings) => ({
  workspace: {
    workspace_path: workspacePath,
  },
})

const toIndexBuildBody = (workspacePath: string, mode: RagIndexBuildMode = 'incremental', path?: string) => omitUndefined({
  workspace: {
    workspace_path: workspacePath,
  },
  mode,
  path,
})

const requestJson = async <T>(path: string, method: 'POST' | 'DELETE', body: unknown): Promise<Result<T>> => {
  try {
    const response = await fetch(`${RAG_BASE_URL}${path}`, {
      method,
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

const postJson = async <T>(path: string, body: unknown): Promise<Result<T>> => requestJson<T>(path, 'POST', body)
const deleteJson = async <T>(path: string, body: unknown): Promise<Result<T>> => requestJson<T>(path, 'DELETE', body)

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
    })
    if (!result.success) return result
    if (result.data?.error) return { success: false, error: result.data.error }
    return result
  },

  async getDetailedIndexStatus(workspacePath: string): Promise<Result<RagIndexStatus>> {
    return aiService.getIndexStatus(workspacePath, {} as RagRequestSettings)
  },

  async streamBuildManagedIndex(
    workspacePath: string,
    mode: RagIndexBuildMode,
    onEvent: (event: RagStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    return streamNdjson<RagStreamEvent>('/rag/index/build/stream', toIndexBuildBody(workspacePath, mode), onEvent, signal)
  },

  async reindexFile(workspacePath: string, path: string): Promise<Result<RagIndexResult>> {
    return postJson<RagIndexResult>('/rag/index/file/reindex', toIndexBuildBody(workspacePath, 'incremental', path))
  },

  async getFileChunks(workspacePath: string, path: string): Promise<Result<RagFileChunksResult>> {
    return postJson<RagFileChunksResult>('/rag/index/file/chunks', toIndexBuildBody(workspacePath, 'incremental', path))
  },

  async deleteFileIndex(workspacePath: string, path: string): Promise<Result<RagIndexResult>> {
    return deleteJson<RagIndexResult>('/rag/index/file', toIndexBuildBody(workspacePath, 'incremental', path))
  },

  async deleteAllIndex(workspacePath: string): Promise<Result<RagIndexResult>> {
    return deleteJson<RagIndexResult>('/rag/index', toIndexBuildBody(workspacePath, 'incremental'))
  },

  async streamBuildVectorIndex(
    workspacePath: string,
    aiSettings: RagRequestSettings,
    onEvent: (event: RagStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    return streamNdjson<RagStreamEvent>('/rag/index/build/stream', toIndexBuildBody(workspacePath, 'incremental'), onEvent, signal)
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

  async summarizeConversation(
    messages: RagChatMessage[],
    maxChars: number,
    aiSettings: RagRequestSettings,
  ): Promise<Result<ChatAnswer>> {
    const history: RagChatMessage[] = [
      {
        role: 'system',
        content: '你是 Looma 的对话上下文压缩器。请把用户提供的早期多轮对话重新总结为结构化长期上下文摘要，保留用户目标、关键事实、已确认结论、未完成事项、重要约束和专有名词。不要逐条照抄原文，不要添加不存在的信息。',
      },
      ...messages,
    ]
    const question = `请将以上早期对话压缩为不超过 ${maxChars} 个中文字符的摘要。输出 Markdown，包含：关键信息、已达成结论、待继续事项。`
    return postJson<ChatAnswer>('/chat', toChatRequestBody(question, aiSettings, history))
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
