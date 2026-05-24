import type { Result } from '../../common/interface/Result'

const RAG_BASE_URL = process.env.RAG_SERVICE_URL || 'http://127.0.0.1:8765'

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
  exists?: boolean
  persist_dir?: string
  error?: string
}

export interface RagIndexStatus {
  exists: boolean
  persist_dir?: string
  error?: string
}

export type RagStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'sources'; sources: RagSource[] }
  | { type: 'done' }
  | { type: 'error'; error: string }

export interface RagAiSettings {
  llmModel: string
  embedModel: string
  ollamaBaseUrl: string
  vectorStorePath: string
}

interface RAGService {
  health(): Promise<Result<{ status: string; service: string }>>

  getIndexStatus(workspacePath: string, aiSettings: RagAiSettings): Promise<Result<RagIndexStatus>>

  buildVectorIndex(workspacePath: string, aiSettings: RagAiSettings): Promise<Result<RagIndexResult>>

  queryAssistant(workspacePath: string, question: string, aiSettings: RagAiSettings): Promise<Result<RagAnswer>>

  streamAssistant(
    workspacePath: string,
    question: string,
    aiSettings: RagAiSettings,
    onEvent: (event: RagStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<Result<void>>
}

const toAiRequestBody = (aiSettings: RagAiSettings) => ({
  llm_model: aiSettings.llmModel,
  embed_model: aiSettings.embedModel,
  ollama_base_url: aiSettings.ollamaBaseUrl,
  vector_store_path: aiSettings.vectorStorePath,
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

export const ragService: RAGService = {
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

  async getIndexStatus(workspacePath: string, aiSettings: RagAiSettings): Promise<Result<RagIndexStatus>> {
    const result = await postJson<RagIndexStatus>('/index/status', {
      workspace_path: workspacePath,
      vector_store_path: aiSettings.vectorStorePath,
    })
    if (!result.success) return result
    if (result.data?.error) return { success: false, error: result.data.error }
    return result
  },

  async buildVectorIndex(workspacePath: string, aiSettings: RagAiSettings): Promise<Result<RagIndexResult>> {
    const result = await postJson<RagIndexResult>('/index', {
      workspace_path: workspacePath,
      ...toAiRequestBody(aiSettings),
    })
    if (!result.success) return result
    if (result.data?.status === 'error') return { success: false, error: result.data.error || '建立索引失败' }
    if (result.data?.document_count !== 0 && result.data?.exists !== true) {
      return {
        success: false,
        error: result.data?.persist_dir
          ? `索引文件未写入预期目录：${result.data.persist_dir}`
          : '索引文件未写入预期目录',
      }
    }
    return result
  },

  async queryAssistant(workspacePath: string, question: string, aiSettings: RagAiSettings): Promise<Result<RagAnswer>> {
    return postJson<RagAnswer>('/ask', {
      workspace_path: workspacePath,
      question,
      ...toAiRequestBody(aiSettings),
    })
  },

  async streamAssistant(
    workspacePath: string,
    question: string,
    aiSettings: RagAiSettings,
    onEvent: (event: RagStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    try {
      const response = await fetch(`${RAG_BASE_URL}/ask/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_path: workspacePath,
          question,
          ...toAiRequestBody(aiSettings),
        }),
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
      const parseLine = (line: string): Result<RagStreamEvent> => {
        try {
          return { success: true, data: JSON.parse(line) as RagStreamEvent }
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
  },
}
