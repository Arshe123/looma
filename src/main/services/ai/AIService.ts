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

export type AgentToolName = 'rag_search' | 'workspace_list' | 'workspace_search' | 'file_read' | 'file_patch'

export interface AgentFileProposalPayload {
  requiresApproval: true
  path: string
  operation: 'create' | 'update'
  unified_diff: string
  expected_sha256: string | null
  proposed_sha256: string
  proposed_content: string
}

export interface AgentRunOptions {
  input: string
  history?: RagChatMessage[]
  enabledTools?: AgentToolName[]
  maxSteps?: number
  toolTimeoutSeconds?: number
  runTimeoutSeconds?: number
}

export interface AgentErrorPayload {
  code: string
  message: string
  technical_detail?: string | null
  retryable: boolean
}

export interface AgentToolResultPayload {
  tool: string
  success: boolean
  summary: string
  data: unknown
  error: AgentErrorPayload | null
  truncated: boolean
}

export type AgentStreamEvent =
  | { type: 'run_started'; runId: string; startedAt: string }
  | { type: 'timeline'; runId: string; step: number; stepId: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; summary: string }
  | { type: 'tool_call'; runId: string; step: number; stepId: string; callId: string; tool: AgentToolName; arguments: Record<string, unknown>; thought_summary: string }
  | { type: 'tool_result'; runId: string; step: number; stepId: string; callId: string; result: AgentToolResultPayload }
  | { type: 'approval_required'; runId: string; step: number; stepId: string; callId: string; approvalId: string; tool: 'file_patch'; proposal: AgentFileProposalPayload; requestedAt: string; deadlineAt: string }
  | { type: 'approval_resolved'; runId: string; step: number; stepId: string; callId: string; approvalId: string; resolution: { status: 'approved' | 'rejected' | 'expired' | 'cancelled'; reason?: string | null; resolvedAt?: string | null; applied?: boolean | null } }
  | { type: 'sources'; runId: string; sources: Array<Record<string, unknown>> }
  | { type: 'delta'; runId: string; text: string; content: string }
  | { type: 'done'; runId: string; status: 'completed' | 'cancelled'; answer?: string }
  | { type: 'error'; runId: string; error: AgentErrorPayload }

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

  summarizeAgentConversation(messages: RagChatMessage[], maxChars: number): Promise<Result<ChatAnswer>>

  streamAgent(
    workspacePath: string,
    options: AgentRunOptions,
    onEvent: (event: AgentStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<Result<void>>

  resolveAgentApproval(approvalId: string, status: 'approved' | 'rejected', reason?: string, applied?: boolean): Promise<Result<{ approvalId: string; runId: string; status: string }>>
}

const AGENT_TOOLS: readonly AgentToolName[] = ['rag_search', 'workspace_list', 'workspace_search', 'file_read', 'file_patch']
const AGENT_TOOL_SET = new Set<string>(AGENT_TOOLS)
const MAX_AGENT_INPUT_CHARS = 32_000
const MAX_AGENT_HISTORY_MESSAGES = 50
const MAX_AGENT_HISTORY_CHARS = 100_000
const MAX_NDJSON_LINE_CHARS = 1_000_000

const clampInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

export const normalizeAgentRunOptions = (options: AgentRunOptions): Required<Omit<AgentRunOptions, 'history' | 'enabledTools'>> & {
  history: RagChatMessage[]
  enabledTools: AgentToolName[]
} => {
  const input = typeof options?.input === 'string' ? options.input.trim() : ''
  if (!input) throw new Error('Agent input is required')
  if (input.length > MAX_AGENT_INPUT_CHARS) throw new Error('Agent input is too large')
  const rawTools = options.enabledTools ?? [...AGENT_TOOLS]
  if (!Array.isArray(rawTools) || rawTools.some(tool => !AGENT_TOOL_SET.has(tool))) {
    throw new Error('Unsupported Agent tool')
  }
  const enabledTools = [...new Set(rawTools)] as AgentToolName[]
  const rawHistory = Array.isArray(options.history) ? options.history : []
  if (rawHistory.length > MAX_AGENT_HISTORY_MESSAGES) throw new Error('Agent history has too many messages')
  const history = rawHistory
      .filter(item => item && ['user', 'assistant', 'system', 'tool'].includes(item.role) && typeof item.content === 'string' && item.content.trim())
      .map(item => ({
        role: item.role,
        content: item.content.trim(),
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined,
      }))
  if (history.reduce((total, item) => total + item.content.length, 0) > MAX_AGENT_HISTORY_CHARS) {
    throw new Error('Agent history is too large')
  }
  return {
    input,
    history,
    enabledTools,
    maxSteps: clampInteger(options.maxSteps, 8, 1, 50),
    toolTimeoutSeconds: clampInteger(options.toolTimeoutSeconds, 30, 1, 300),
    runTimeoutSeconds: clampInteger(options.runTimeoutSeconds, 300, 1, 1800),
  }
}

const isRecord = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isNonEmptyString = (value: unknown): value is string => isString(value) && value.trim().length > 0
const AGENT_ERROR_FIELDS = new Set(['code', 'message', 'technical_detail', 'retryable'])
const isErrorPayload = (value: unknown): value is AgentErrorPayload => isRecord(value)
  && Object.keys(value).every(key => AGENT_ERROR_FIELDS.has(key))
  && isNonEmptyString(value.code) && isNonEmptyString(value.message) && typeof value.retryable === 'boolean'
  && (value.technical_detail === undefined || value.technical_detail === null || isString(value.technical_detail))

export const isAgentStreamEvent = (value: unknown): value is AgentStreamEvent => {
  if (!isRecord(value) || !isNonEmptyString(value.type) || !isNonEmptyString(value.runId)) return false
  switch (value.type) {
    case 'run_started': return isNonEmptyString(value.startedAt)
    case 'timeline': return Number.isInteger(value.step) && isNonEmptyString(value.stepId)
      && ['pending', 'running', 'completed', 'failed', 'cancelled'].includes(value.status)
      && isString(value.summary)
    case 'tool_call': return Number.isInteger(value.step) && isNonEmptyString(value.stepId)
      && isNonEmptyString(value.callId) && AGENT_TOOL_SET.has(value.tool) && isRecord(value.arguments)
      && isString(value.thought_summary)
    case 'tool_result': return Number.isInteger(value.step) && isNonEmptyString(value.stepId)
      && isNonEmptyString(value.callId) && isRecord(value.result)
      && AGENT_TOOL_SET.has(value.result.tool) && typeof value.result.success === 'boolean'
      && isString(value.result.summary) && typeof value.result.truncated === 'boolean'
      && (value.result.error === null || isErrorPayload(value.result.error))
      && Object.prototype.hasOwnProperty.call(value.result, 'data')
      && (value.result.success ? value.result.error === null : isErrorPayload(value.result.error))
    case 'approval_required': return Number.isInteger(value.step) && isNonEmptyString(value.stepId)
      && isNonEmptyString(value.callId) && isNonEmptyString(value.approvalId) && value.tool === 'file_patch'
      && isNonEmptyString(value.requestedAt) && isNonEmptyString(value.deadlineAt) && isRecord(value.proposal)
      && value.proposal.requiresApproval === true && isNonEmptyString(value.proposal.path)
      && ['create', 'update'].includes(value.proposal.operation) && isString(value.proposal.unified_diff)
      && (value.proposal.expected_sha256 === null || (isString(value.proposal.expected_sha256) && /^[a-f0-9]{64}$/.test(value.proposal.expected_sha256)))
      && isString(value.proposal.proposed_sha256) && /^[a-f0-9]{64}$/.test(value.proposal.proposed_sha256)
      && isString(value.proposal.proposed_content)
    case 'approval_resolved': return Number.isInteger(value.step) && isNonEmptyString(value.stepId)
      && isNonEmptyString(value.callId) && isNonEmptyString(value.approvalId) && isRecord(value.resolution)
      && ['approved', 'rejected', 'expired', 'cancelled'].includes(value.resolution.status)
    case 'sources': return Array.isArray(value.sources) && value.sources.every(isRecord)
    case 'delta': return isString(value.text) && isString(value.content) && value.text === value.content
    case 'done': return ['completed', 'cancelled'].includes(value.status)
      && (value.answer === undefined || isString(value.answer))
    case 'error': return isErrorPayload(value.error)
    default: return false
  }
}

const toAgentRequestBody = (workspacePath: string, rawOptions: AgentRunOptions) => {
  const options = normalizeAgentRunOptions(rawOptions)
  return {
    input: options.input,
    workspace: { workspace_path: workspacePath },
    history: options.history,
    agent: {
      enabled_tools: options.enabledTools,
      max_steps: options.maxSteps,
      tool_timeout_seconds: options.toolTimeoutSeconds,
      run_timeout_seconds: options.runTimeoutSeconds,
      allow_write: options.enabledTools.includes('file_patch'),
    },
  }
}

const omitUndefined = <T extends Record<string, unknown>>(value: T): T => {
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  return Object.fromEntries(entries) as T
}


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
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let reachedEof = false
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

    reader = response.body.getReader()
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
      if (done) {
        reachedEof = true
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        if (rawLine.length > MAX_NDJSON_LINE_CHARS) {
          return { success: false, error: 'RAG 流事件超过大小限制。' }
        }
        const line = rawLine.trim()
        if (!line) continue
        const parsed = parseLine(line)
        if (!parsed.success) return { success: false, error: parsed.error }
        onEvent(parsed.data)
      }
      if (buffer.length > MAX_NDJSON_LINE_CHARS) {
        return { success: false, error: 'RAG 流事件超过大小限制。' }
      }
    }

    buffer += decoder.decode()
    const finalLine = buffer.trim()
    if (finalLine.length > MAX_NDJSON_LINE_CHARS) {
      return { success: false, error: 'RAG 流事件超过大小限制。' }
    }
    if (finalLine) {
      const parsed = parseLine(finalLine)
      if (!parsed.success) return { success: false, error: parsed.error }
      onEvent(parsed.data)
    }

    return { success: true }
  } catch (error: any) {
    if (error?.name === 'AbortError') return { success: true }
    return { success: false, error: `无法连接 RAG 服务: ${error?.message ?? String(error)}` }
  } finally {
    if (reader) {
      if (!reachedEof) {
        await reader.cancel().catch(() => {})
      }
      reader.releaseLock()
    }
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

  async summarizeAgentConversation(messages: RagChatMessage[], maxChars: number): Promise<Result<ChatAnswer>> {
    return postJson<ChatAnswer>('/agent/summarize', { messages, max_chars: maxChars })
  },

  async streamAgent(
    workspacePath: string,
    options: AgentRunOptions,
    onEvent: (event: AgentStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    return streamNdjson<unknown>(
      '/agent/run/stream',
      toAgentRequestBody(workspacePath, options),
      (event) => {
        if (isAgentStreamEvent(event)) {
          onEvent(event)
          return
        }
        console.warn('Ignored invalid Agent stream event')
      },
      signal,
    )
  },

  async resolveAgentApproval(approvalId, status, reason, applied) {
    return postJson('/agent/approvals/resolve', {
      approval_id: approvalId,
      status,
      reason,
      applied,
    })
  },
}
