import { defineStore } from 'pinia'
import type { AgentEvent, AgentSource } from '../../shared/types/agent-events'
import { useSettingsStore } from './settings'
import { useWorkspaceStore } from './workspace'
import type { AiAssistantMessage, AiAssistantTimelineOutput, AiAssistantTimelineStep } from './workspace'
import { normalizeAiAssistantSourcePath } from './workspace-ai-utils'
import {
  applyRagTimelineEvent,
  createIndexTimeline,
  failAiTimelineStep,
  formatAiRuntimeError,
} from '../components/ai/aiTimeline'
import { projectAgentRunView } from './agent-event-view'
import {
  flattenAgentHistoryForSummary,
  normalizeAgentConversationHistory,
  type AgentHistoryMessage,
} from './agent-history'

type RagChatMessagePayload = AgentHistoryMessage

type RagRequestStatsPayload = {
  history_messages: number
  history_token_estimate: number
  question_token_estimate: number
  total_token_estimate: number
  recent_turns: number
  distant_summary_enabled: boolean
  distant_summary_messages: number
}

type RagSourcePayload = {
  score: number | null
  text: string
  metadata: Record<string, unknown>
}

type RagStreamEventPayload =
  | { requestId: string; type: 'timeline'; stepId?: string; status?: 'pending' | 'active' | 'completed' | 'error'; title?: string; description?: string; detail?: string; outputs?: unknown[]; step?: Record<string, unknown> }
  | { requestId: string; type: 'progress'; stepId: string; current: number; total?: number; message?: string }
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'sources'; sources: RagSourcePayload[] }
  | { requestId: string; type: 'done'; result?: Record<string, unknown>; status?: string; document_count?: number; exists?: boolean; persist_dir?: string }
  | { requestId: string; type: 'error'; error: string; stepId?: string }

type AiIndexStreamState = {
  requestId: string
  workspaceId: string
  conversationId: string
  messageId: number
  timeline: AiAssistantTimelineStep[]
  status: 'starting' | 'streaming' | 'done' | 'error' | 'cancelled'
  startedAt: number
  error?: string
}

type AiIndexResultState = {
  exists: boolean
  documentCount: number
}

type AgentToolName = 'rag_search' | 'workspace_list' | 'workspace_search' | 'file_read' | 'file_patch'

export type AgentRecoveryState = {
  recoverable: boolean
  checkpointAvailable: boolean
  reason: string
  resuming?: boolean
  continuedToRunId?: string
}

export type AgentApprovalState = {
  approvalId: string
  stepId: string
  path: string
  operation: 'create' | 'update'
  diff: string
  requestedAt: string
  deadlineAt: string
  status: 'pending' | 'resolving' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'error'
  error?: string
}

type AgentStreamEventData =
  | { requestId: string; type: 'run_started'; runId: string; startedAt: string }
  | { requestId: string; type: 'timeline'; runId: string; step: number; stepId: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; summary: string }
  | { requestId: string; type: 'tool_call'; runId: string; step: number; stepId: string; callId: string; tool: AgentToolName; arguments: Record<string, unknown>; thought_summary: string }
  | { requestId: string; type: 'tool_result'; runId: string; step: number; stepId: string; callId: string; result: Record<string, any> }
  | { requestId: string; type: 'approval_required'; runId: string; step: number; stepId: string; callId: string; approvalId: string; tool: 'file_patch'; proposal: { path: string; operation: 'create' | 'update'; unified_diff: string }; requestedAt: string; deadlineAt: string }
  | { requestId: string; type: 'approval_resolved'; runId: string; step: number; stepId: string; callId: string; approvalId: string; resolution: { status: 'approved' | 'rejected' | 'expired' | 'cancelled'; reason?: string | null; applied?: boolean | null } }
  | { requestId: string; type: 'sources'; runId: string; sources: Array<Record<string, unknown>> }
  | { requestId: string; type: 'delta'; runId: string; text: string; content: string }
  | { requestId: string; type: 'done'; runId: string; status: 'completed' | 'cancelled'; answer?: string }
  | { requestId: string; type: 'usage_updated'; runId: string; operationId: string; phase: 'decision' | 'tool' | 'finalization' | 'continuation'; provider?: string | null; model?: string | null; inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null; latencyMs: number; cost?: { amount: number; currency: 'USD'; estimated: boolean } | null }
  | { requestId: string; type: 'continuation_created' | 'run_interrupted' | 'recovery_failed'; runId: string; parentRunId?: string; reason?: string; message?: string }
  | { requestId: string; type: 'error'; runId: string; error: { code: string; message: string; technical_detail?: string | null; retryable: boolean } }

type AgentStreamEventPayload = AgentStreamEventData & {
  agentEvents?: AgentEvent[]
  agentSources?: AgentSource[]
}

type AgentConversationRunState = {
  requestId: string
  taskId?: string
  runId?: string
  workspaceId: string
  conversationId: string
  assistantMessageId: number
  assistantText: string
  status: 'starting' | 'streaming' | 'cancelling'
  startedAt: number
  approvalResolutionInFlight: Record<string, boolean>
}

type ConversationPreparingState = {
  workspaceId: string
  cancelled: boolean
}

const compactText = (value: unknown, maxLength: number) => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
)

const getAgentDisplayMessageKey = (conversationId: string, messageId: number) => `${conversationId}:${messageId}`

const estimateTokenCount = (text: string) => {
  const normalized = text.trim()
  if (!normalized) return 0
  const cjkChars = normalized.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const nonCjkText = normalized.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
  const asciiTokenEstimate = Math.ceil(nonCjkText.replace(/\s+/g, ' ').trim().length / 4)
  return Math.max(1, cjkChars + asciiTokenEstimate)
}

const estimateMessageTokens = (message: RagChatMessagePayload) => {
  const toolMetadata = message.tool_calls?.length
    ? JSON.stringify(message.tool_calls)
    : `${message.name || ''}${message.tool_call_id || ''}`
  return estimateTokenCount(`${message.content}${toolMetadata}`) + 4
}

const CONVERSATION_SUMMARY_PREFIX = '系统：已压缩早期对话'
const CONVERSATION_SUMMARY_PENDING_TEXT = '系统：正在压缩早期对话，请稍候...'

const isConversationSummaryMessage = (message: AiAssistantMessage) =>
  message.role === 'system' && message.text.trim().startsWith(CONVERSATION_SUMMARY_PREFIX)

const getConversationSummaryContent = (text: string) => {
  const value = text.trim()
  const divider = value.indexOf('\n\n')
  return divider >= 0 ? value.slice(divider + 2).trim() : value.replace(CONVERSATION_SUMMARY_PREFIX, '').trim()
}

const getConversationSummaryTurnIndex = (text: string) => {
  const match = text.match(/已总结至第\s*(\d+)\s*次用户对话/)
  return match ? Number(match[1]) : 0
}

const findLatestConversationSummaryIndex = (sourceMessages: AiAssistantMessage[]) => {
  for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
    if (isConversationSummaryMessage(sourceMessages[index])) return index
  }
  return -1
}

const countUserTurns = (history: RagChatMessagePayload[]) => history.filter((message) => message.role === 'user').length

const selectRecentConversationMessages = (allMessages: RagChatMessagePayload[], recentTurns: number) => {
  if (recentTurns <= 0) return []
  let userTurns = 0
  let startIndex = allMessages.length
  for (let index = allMessages.length - 1; index >= 0; index -= 1) {
    startIndex = index
    if (allMessages[index].role === 'user') {
      userTurns += 1
      if (userTurns >= recentTurns) break
    }
  }
  return allMessages.slice(startIndex)
}

const splitMessagesKeepingRecentTurns = (allMessages: RagChatMessagePayload[], keepRecentTurns: number) => {
  const retainedMessages = selectRecentConversationMessages(allMessages, keepRecentTurns)
  return {
    messagesToSummarize: allMessages.slice(0, allMessages.length - retainedMessages.length),
    retainedMessages,
  }
}

const normalizeConversationMessagesForContext = normalizeAgentConversationHistory

const buildConversationStats = (
  currentQuestion: string,
  history: RagChatMessagePayload[],
  recentTurns: number,
  distantSummaryMessages: number,
  distantSummaryEnabled: boolean,
): RagRequestStatsPayload => {
  const historyTokenEstimate = history.reduce((total, message) => total + estimateMessageTokens(message), 0)
  const questionTokenEstimate = estimateTokenCount(currentQuestion) + 4
  return {
    history_messages: history.length,
    history_token_estimate: historyTokenEstimate,
    question_token_estimate: questionTokenEstimate,
    total_token_estimate: historyTokenEstimate + questionTokenEstimate,
    recent_turns: recentTurns,
    distant_summary_enabled: distantSummaryEnabled,
    distant_summary_messages: distantSummaryMessages,
  }
}

const createConversationContextTimeline = (stats: RagRequestStatsPayload, startedAt = Date.now()): AiAssistantTimelineStep[] => [{
  id: 'conversation-context',
  title: '整理对话上下文',
  description: '按 AI 设置中的上下文策略整理最近对话和远对话摘要，并估算本次请求上下文 token。',
  detail: `最近 ${stats.recent_turns} 轮内加入 ${stats.history_messages} 条历史消息${stats.distant_summary_enabled ? `，并压缩 ${stats.distant_summary_messages} 条更早消息为摘要` : ''}，整轮上下文约 ${stats.total_token_estimate} tokens。`,
  status: 'completed',
  startedAt,
  endedAt: startedAt,
  outputs: [
    { id: 'history-messages', type: 'metric', title: '历史消息', value: stats.history_messages, unit: '条' },
    { id: 'recent-turns', type: 'metric', title: '保留最近轮数', value: stats.recent_turns, unit: '轮' },
    { id: 'history-token-estimate', type: 'metric', title: '历史上下文', value: stats.history_token_estimate, unit: ' tokens' },
    { id: 'question-token-estimate', type: 'metric', title: '当前问题', value: stats.question_token_estimate, unit: ' tokens' },
    { id: 'total-token-estimate', type: 'metric', title: '会话总计', value: stats.total_token_estimate, unit: ' tokens' },
  ],
}]

const createSourceOutputs = (sources: RagSourcePayload[]): AiAssistantTimelineOutput[] =>
  sources.slice(0, 5).map((source, index) => {
    const path = typeof source.metadata?.source === 'string'
      ? source.metadata.source
      : typeof source.metadata?.file_path === 'string'
        ? source.metadata.file_path
        : typeof source.metadata?.path === 'string'
          ? source.metadata.path
          : ''
    return {
      id: `source-${index + 1}`,
      type: 'source',
      title: path ? `来源 ${index + 1}` : `片段 ${index + 1}`,
      content: source.text.slice(0, 260),
      path: normalizeAiAssistantSourcePath(path),
      metadata: {
        ...source.metadata,
        score: source.score,
      },
    }
  })

export const useAiAssistantStore = defineStore('aiAssistant', {
  state: () => ({
    indexStreamsByWorkspaceId: {} as Record<string, AiIndexStreamState>,
    indexRequestIdToWorkspaceId: {} as Record<string, string>,
    indexResultsByWorkspaceId: {} as Record<string, AiIndexResultState>,
    subscribeIndexStreamEvents: null as null | (() => void),
    agentRunsByConversationId: {} as Record<string, AgentConversationRunState>,
    agentRequestIdToConversationId: {} as Record<string, string>,
    agentEventsByMessageKey: {} as Record<string, AgentEvent[]>,
    agentSourcesByMessageKey: {} as Record<string, AgentSource[]>,
    agentRecoveryByMessageKey: {} as Record<string, AgentRecoveryState>,
    subscribeAgentStreamEvents: null as null | (() => void),
    agentStartingConversationIds: {} as Record<string, ConversationPreparingState>,
  }),
  getters: {
    isConversationRunningAgent: (state) => (conversationId: string | null | undefined) => (
      Boolean(conversationId && (state.agentRunsByConversationId[conversationId] || state.agentStartingConversationIds[conversationId]))
    ),
    getConversationAgentRun: (state) => (conversationId: string | null | undefined) => (
      conversationId ? state.agentRunsByConversationId[conversationId] || null : null
    ),
    getConversationAgentApprovals: (state) => (conversationId: string | null | undefined) => {
      if (!conversationId) return []
      const run = state.agentRunsByConversationId[conversationId]
      if (!run) return []
      const key = getAgentDisplayMessageKey(conversationId, run.assistantMessageId)
      return projectAgentRunView(state.agentEventsByMessageKey[key] || [], state.agentSourcesByMessageKey[key] || [])
        .approvals.map((approval): AgentApprovalState => ({
          ...approval,
          status: run.approvalResolutionInFlight[approval.approvalId] ? 'resolving' : approval.status,
        }))
    },
    getMessageAgentRecovery: (state) => (conversationId: string | null | undefined, messageId: number | undefined, runId?: string): AgentRecoveryState | null => {
      if (!conversationId || messageId === undefined || !runId) return null
      const key = getAgentDisplayMessageKey(conversationId, messageId)
      const cached = state.agentRecoveryByMessageKey[key]
      if (cached) return cached
      const projection = projectAgentRunView(state.agentEventsByMessageKey[key] || [], state.agentSourcesByMessageKey[key] || [])
      if (!['failed', 'cancelled'].includes(projection.state.status)) return null
      return { recoverable: true, checkpointAvailable: false, reason: '将从已确认的事件和消息继续。' }
    },
    getMessageAgentDisplayEvents: (state) => (conversationId: string | null | undefined, messageId: number | undefined) => {
      if (!conversationId || messageId === undefined) return []
      const key = getAgentDisplayMessageKey(conversationId, messageId)
      return projectAgentRunView(state.agentEventsByMessageKey[key] || [], state.agentSourcesByMessageKey[key] || []).displayEvents
    },
    isWorkspaceIndexing: (state) => (workspaceId: string | null | undefined) => (
      Boolean(workspaceId && state.indexStreamsByWorkspaceId[workspaceId])
    ),
    getWorkspaceIndexStream: (state) => (workspaceId: string | null | undefined) => (
      workspaceId ? state.indexStreamsByWorkspaceId[workspaceId] || null : null
    ),
    getWorkspaceIndexResult: (state) => (workspaceId: string | null | undefined) => (
      workspaceId ? state.indexResultsByWorkspaceId[workspaceId] || null : null
    ),
  },
  actions: {
    createStreamRequestId() {
      return `${Date.now()}_${Math.random().toString(36).slice(2)}`
    },

    appendCanonicalAgentFacts(run: AgentConversationRunState, payload: AgentStreamEventPayload) {
      const key = getAgentDisplayMessageKey(run.conversationId, run.assistantMessageId)
      const existingEvents = this.agentEventsByMessageKey[key] || []
      const knownEventIds = new Set(existingEvents.map((event) => event.id))
      const nextEvents = (payload.agentEvents || []).filter((event) => event.runId === (run.runId || event.runId) && !knownEventIds.has(event.id))
      if (nextEvents.length) this.agentEventsByMessageKey[key] = [...existingEvents, ...nextEvents].sort((a, b) => a.sequence - b.sequence)

      const existingSources = this.agentSourcesByMessageKey[key] || []
      const knownSourceIds = new Set(existingSources.map((source) => source.sourceId))
      const nextSources = (payload.agentSources || []).filter((source) => !knownSourceIds.has(source.sourceId))
      if (nextSources.length) this.agentSourcesByMessageKey[key] = [...existingSources, ...nextSources]
    },

    syncAgentProjection(run: AgentConversationRunState) {
      const key = getAgentDisplayMessageKey(run.conversationId, run.assistantMessageId)
      const projection = projectAgentRunView(this.agentEventsByMessageKey[key] || [], this.agentSourcesByMessageKey[key] || [])
      const status = projection.state.status === 'failed'
        ? 'error'
        : projection.state.status === 'cancelled'
          ? 'cancelled'
          : projection.state.status === 'completed'
            ? 'completed'
            : 'running'
      const workspaceStore = useWorkspaceStore()
      workspaceStore.updateAiAssistantMessageTimelineInConversation(run.conversationId, run.assistantMessageId, projection.timeline, { persist: false })
      workspaceStore.updateAiAssistantMessageMetaInConversation(run.conversationId, run.assistantMessageId, {
        taskId: run.taskId,
        runId: run.runId,
        agentSummary: {
          status,
          toolCallCount: projection.toolCallCount,
          sourceCount: projection.sourceCount,
          ...(projection.state.status === 'failed' ? { error: { message: projection.state.currentStep } } : {}),
        },
      }, { persist: false })
      return projection
    },

    async hydrateAgentHistory(workspaceId: string, conversations: Array<{ id: string; messages: AiAssistantMessage[] }>) {
      const workspaceStore = useWorkspaceStore()
      const getRun = (window as any).electronAPI?.agent?.getRun
      if (typeof getRun !== 'function') return
      const entries = conversations.flatMap(conversation => conversation.messages
        .filter(message => message.mode === 'agent' && typeof message.runId === 'string' && Boolean(message.runId))
        .map(message => ({ conversationId: conversation.id, message })))
      await Promise.all(entries.map(async ({ conversationId, message }) => {
        const result = await (window as any).electronAPI.agent.getRun(workspaceId, message.runId)
        if (!result?.success || !result.data) return
        const key = getAgentDisplayMessageKey(conversationId, message.id)
        this.agentEventsByMessageKey[key] = result.data.events
        this.agentSourcesByMessageKey[key] = result.data.sources
        this.agentRecoveryByMessageKey[key] = result.data.recovery
        const projection = projectAgentRunView(result.data.events, result.data.sources)
        workspaceStore.updateAiAssistantMessageTimelineInConversation(conversationId, message.id, projection.timeline, { persist: false })
        workspaceStore.updateAiAssistantMessageMetaInConversation(conversationId, message.id, {
          taskId: result.data.run.taskId,
          runId: result.data.run.id,
          agentSummary: {
            status: projection.state.status === 'failed'
              ? 'error'
              : projection.state.status === 'cancelled'
                ? 'cancelled'
                : projection.state.status === 'completed'
                  ? 'completed'
                  : 'running',
            toolCallCount: projection.toolCallCount,
            sourceCount: projection.sourceCount,
            ...(projection.state.status === 'failed' ? { error: { message: projection.state.currentStep } } : {}),
          },
        }, { persist: false })
      }))
    },

    ensureAgentStreamEventSubscription() {
      if (this.subscribeAgentStreamEvents) return
      this.subscribeAgentStreamEvents = (window as any).electronAPI.agent.runStream.onEvent((payload: AgentStreamEventPayload) => {
        this.handleAgentStreamEvent(payload)
      })
    },

    disposeAgentStreamEventSubscription() {
      this.subscribeAgentStreamEvents?.()
      this.subscribeAgentStreamEvents = null
    },

    ensureIndexStreamEventSubscription() {
      if (this.subscribeIndexStreamEvents) return
      this.subscribeIndexStreamEvents = (window as any).electronAPI.rag.indexStream.onEvent((payload: RagStreamEventPayload) => {
        this.handleIndexStreamEvent(payload)
      })
    },

    disposeIndexStreamEventSubscription() {
      this.subscribeIndexStreamEvents?.()
      this.subscribeIndexStreamEvents = null
    },

    setWorkspaceIndexResult(workspaceId: string, result: AiIndexResultState) {
      this.indexResultsByWorkspaceId[workspaceId] = result
    },

    async startWorkspaceIndex(options: { workspaceId: string; conversationId?: string }) {
      if (!options.workspaceId) return { success: false, error: 'Workspace not found' }
      if (this.indexStreamsByWorkspaceId[options.workspaceId]) return { success: false, error: '当前工作空间正在建立索引，请等待完成。' }

      this.ensureIndexStreamEventSubscription()
      const conversationId = options.conversationId || useWorkspaceStore().ensureAiAssistantConversationForRequest()
      const messageId = useWorkspaceStore().appendAiAssistantMessageToConversation(conversationId, 'assistant', '正在建立当前工作空间索引...')
      if (!messageId) return { success: false, error: 'Index message could not be created' }

      const requestId = this.createStreamRequestId()
      const timeline = createIndexTimeline(Date.now())
      this.indexStreamsByWorkspaceId[options.workspaceId] = {
        requestId,
        workspaceId: options.workspaceId,
        conversationId,
        messageId,
        timeline,
        status: 'starting',
        startedAt: Date.now(),
      }
      this.indexRequestIdToWorkspaceId[requestId] = options.workspaceId
      useWorkspaceStore().updateAiAssistantMessageTimelineInConversation(conversationId, messageId, timeline, { persist: true })

      try {
        const result = await (window as any).electronAPI.rag.indexStream.start(requestId, options.workspaceId)
        if (!result.success) {
          this.failWorkspaceIndexStream(options.workspaceId, result.error || '建立索引失败。', 'validate-workspace')
          return result
        }
        const stream = this.indexStreamsByWorkspaceId[options.workspaceId]
        if (stream) stream.status = 'streaming'
        return { success: true }
      } catch (error: any) {
        const errorText = `建立索引失败：${error?.message ?? String(error)}`
        this.failWorkspaceIndexStream(options.workspaceId, errorText, 'validate-workspace')
        return { success: false, error: errorText }
      }
    },

    handleIndexStreamEvent(payload: RagStreamEventPayload) {
      const workspaceId = this.indexRequestIdToWorkspaceId[payload.requestId]
      if (!workspaceId) return
      const stream = this.indexStreamsByWorkspaceId[workspaceId]
      if (!stream || stream.requestId !== payload.requestId) return

      if (payload.type === 'timeline' || payload.type === 'progress') {
        stream.timeline = applyRagTimelineEvent(stream.timeline, payload as any)
        useWorkspaceStore().updateAiAssistantMessageTimelineInConversation(stream.conversationId, stream.messageId, stream.timeline, { persist: false })
        return
      }

      if (payload.type === 'done') {
        const result = payload.result || payload
        const count = typeof result.document_count === 'number' ? result.document_count : 0
        const exists = Boolean(result.exists) && count > 0
        this.indexResultsByWorkspaceId[workspaceId] = { exists, documentCount: count }
        useWorkspaceStore().updateAiAssistantMessageTextInConversation(
          stream.conversationId,
          stream.messageId,
          count === 0
            ? '当前工作空间没有可索引的文档，请添加 Markdown、文本或 PDF 文件后再建立索引。'
            : `索引已建立，共处理 ${count} 个文档。现在可以开始提问。`,
        )
        stream.status = 'done'
        delete this.indexRequestIdToWorkspaceId[stream.requestId]
        delete this.indexStreamsByWorkspaceId[workspaceId]
        return
      }

      if (payload.type === 'error') {
        this.failWorkspaceIndexStream(workspaceId, payload.error || '建立索引失败。', payload.stepId || 'verify-index')
      }
    },

    failWorkspaceIndexStream(workspaceId: string, error: string, stepId = 'verify-index') {
      const stream = this.indexStreamsByWorkspaceId[workspaceId]
      if (!stream) return
      const runtimeError = formatAiRuntimeError(error, '建立索引失败。')
      stream.timeline = failAiTimelineStep(stream.timeline, stepId, runtimeError.message, Date.now(), runtimeError.technicalDetail)
      useWorkspaceStore().updateAiAssistantMessageTimelineInConversation(stream.conversationId, stream.messageId, stream.timeline, { persist: true })
      useWorkspaceStore().updateAiAssistantMessageTextInConversation(stream.conversationId, stream.messageId, `建立索引失败：${runtimeError.message}`)
      this.indexResultsByWorkspaceId[workspaceId] = { exists: false, documentCount: 0 }
      stream.status = 'error'
      stream.error = runtimeError.message
      delete this.indexRequestIdToWorkspaceId[stream.requestId]
      delete this.indexStreamsByWorkspaceId[workspaceId]
    },


    async cancelWorkspaceIndex(workspaceId: string | null) {
      if (!workspaceId) return
      const stream = this.indexStreamsByWorkspaceId[workspaceId]
      if (!stream) return
      await (window as any).electronAPI.rag.indexStream.cancel(stream.requestId).catch(() => {})
      stream.status = 'cancelled'
      delete this.indexRequestIdToWorkspaceId[stream.requestId]
      delete this.indexStreamsByWorkspaceId[workspaceId]
    },

    async startAgentInConversation(options: { workspaceId: string; conversationId?: string; text: string; aiName: string }) {
      const text = options.text.trim()
      if (!options.workspaceId || !text) return { success: false, error: 'Question is required' }

      this.ensureAgentStreamEventSubscription()
      const conversationId = options.conversationId || useWorkspaceStore().ensureAiAssistantConversationForRequest()
      if (this.agentRunsByConversationId[conversationId] || this.agentStartingConversationIds[conversationId]) return { success: false, error: '当前会话已有 Agent 正在运行。' }

      if (!useWorkspaceStore().getAiAssistantConversationById(conversationId)) return { success: false, error: 'Conversation not found' }
      this.agentStartingConversationIds[conversationId] = { workspaceId: options.workspaceId, cancelled: false }

      const settingsStore = useSettingsStore()
      let history: RagChatMessagePayload[]
      try {
        ;({ history } = await this.buildConversationHistoryForRequest(conversationId, text))
      } catch (error: any) {
        if (this.agentStartingConversationIds[conversationId]?.cancelled) {
          delete this.agentStartingConversationIds[conversationId]
          return { success: true, cancelled: true }
        }
        delete this.agentStartingConversationIds[conversationId]
        const runtimeError = formatAiRuntimeError(error?.message ?? String(error), '整理对话上下文失败。')
        return { success: false, error: runtimeError.message }
      }
      if (!this.agentStartingConversationIds[conversationId] || this.agentStartingConversationIds[conversationId].cancelled) {

        delete this.agentStartingConversationIds[conversationId]
        return { success: true, cancelled: true }
      }
      const modelIdentity = {
        provider: settingsStore.aiSettings.chat.provider,
        model: settingsStore.aiSettings.chat.model,
        displayName: options.aiName,
      }
      useWorkspaceStore().setAiAssistantDraft('')
      useWorkspaceStore().appendAiAssistantMessageToConversation(conversationId, 'user', text)
      const assistantMessageId = useWorkspaceStore().appendAiAssistantMessageToConversation(
        conversationId,
        'assistant',
        '',
        undefined,
        {
          aiName: options.aiName,
          mode: 'agent',
          modelIdentity,
          agentSummary: { status: 'running', toolCallCount: 0, sourceCount: 0 },
        },
      )
      if (!assistantMessageId) {
        delete this.agentStartingConversationIds[conversationId]
        return { success: false, error: 'Assistant message could not be created' }
      }

      const requestId = this.createStreamRequestId()
      const startedAt = Date.now()
      this.agentRunsByConversationId[conversationId] = {
        requestId,
        workspaceId: options.workspaceId,
        conversationId,
        assistantMessageId,
        assistantText: '',
        status: 'starting',
        startedAt,
        approvalResolutionInFlight: {},
      }
      const messageKey = getAgentDisplayMessageKey(conversationId, assistantMessageId)
      this.agentEventsByMessageKey[messageKey] = []
      this.agentSourcesByMessageKey[messageKey] = []
      this.agentRequestIdToConversationId[requestId] = conversationId
      delete this.agentStartingConversationIds[conversationId]

      try {
        const result = await (window as any).electronAPI.agent.runStream.start(requestId, options.workspaceId, {
          input: text,
          history,
        })
        if (!result.success) {
          this.failAgentConversation(conversationId, result.error || 'Agent 启动失败。')
          return result
        }
        const run = this.agentRunsByConversationId[conversationId]
        if (run) {
          run.status = 'streaming'
          run.taskId = result.data?.taskId
          run.runId = result.data?.runId
        }
        return { success: true }
      } catch (error: any) {
        const runtimeError = formatAiRuntimeError(error?.message ?? String(error), 'Agent 启动失败。')
        this.failAgentConversation(conversationId, runtimeError.message, runtimeError.technicalDetail)
        return { success: false, error: runtimeError.message }
      }
    },

    async resumeAgentRun(conversationId: string, parentMessage: AiAssistantMessage) {
      const workspaceStore = useWorkspaceStore()
      const workspaceId = workspaceStore.activeWorkspaceId
      if (!workspaceId || !parentMessage.runId || !parentMessage.taskId) return { success: false, error: '恢复信息不完整，请重新发起任务。' }
      if (this.agentRunsByConversationId[conversationId] || this.agentStartingConversationIds[conversationId]) {
        return { success: false, error: '当前会话已有 Agent 正在运行。' }
      }
      const parentKey = getAgentDisplayMessageKey(conversationId, parentMessage.id)
      const recovery = this.getMessageAgentRecovery(conversationId, parentMessage.id, parentMessage.runId)
      if (!recovery?.recoverable || recovery.continuedToRunId) return { success: false, error: recovery?.reason || '当前运行不支持继续。' }
      this.agentRecoveryByMessageKey[parentKey] = { ...recovery, resuming: true }

      this.ensureAgentStreamEventSubscription()
      const assistantMessageId = workspaceStore.appendAiAssistantMessageToConversation(
        conversationId,
        'assistant',
        '',
        undefined,
        {
          aiName: parentMessage.aiName,
          mode: 'agent',
          modelIdentity: parentMessage.modelIdentity,
          taskId: parentMessage.taskId,
          agentSummary: { status: 'running', toolCallCount: 0, sourceCount: 0 },
        },
      )
      if (!assistantMessageId) {
        this.agentRecoveryByMessageKey[parentKey] = { ...recovery, resuming: false }
        return { success: false, error: '无法创建后续运行消息。' }
      }
      const requestId = this.createStreamRequestId()
      const messageKey = getAgentDisplayMessageKey(conversationId, assistantMessageId)
      this.agentEventsByMessageKey[messageKey] = []
      this.agentSourcesByMessageKey[messageKey] = []
      this.agentRunsByConversationId[conversationId] = {
        requestId,
        workspaceId,
        conversationId,
        assistantMessageId,
        assistantText: '',
        status: 'starting',
        startedAt: Date.now(),
        taskId: parentMessage.taskId,
        approvalResolutionInFlight: {},
      }
      this.agentRequestIdToConversationId[requestId] = conversationId
      try {
        const result = await (window as any).electronAPI.agent.resumeRun(requestId, workspaceId, parentMessage.runId)
        if (!result?.success) {
          this.agentRecoveryByMessageKey[parentKey] = { ...recovery, resuming: false }
          this.failAgentConversation(conversationId, result?.error || '创建后续运行失败。')
          return { success: false, error: result?.error || '创建后续运行失败。' }
        }
        const run = this.agentRunsByConversationId[conversationId]
        if (run) {
          run.status = 'streaming'
          run.taskId = result.data.taskId
          run.runId = result.data.runId
        }
        this.agentRecoveryByMessageKey[parentKey] = {
          recoverable: false,
          checkpointAvailable: recovery.checkpointAvailable,
          reason: '任务已在新的后续运行中继续。',
          continuedToRunId: result.data.runId,
        }
        workspaceStore.updateAiAssistantMessageMetaInConversation(conversationId, assistantMessageId, {
          taskId: result.data.taskId,
          runId: result.data.runId,
        }, { persist: true })
        return { success: true, data: result.data }
      } catch (error: any) {
        this.agentRecoveryByMessageKey[parentKey] = { ...recovery, resuming: false }
        const message = compactText(error?.message ?? String(error), 1000) || '创建后续运行失败。'
        this.failAgentConversation(conversationId, message)
        return { success: false, error: message }
      }
    },

    handleAgentStreamEvent(payload: AgentStreamEventPayload) {
      const conversationId = this.agentRequestIdToConversationId[payload.requestId]
      if (!conversationId) return
      const run = this.agentRunsByConversationId[conversationId]
      if (!run || run.requestId !== payload.requestId) return
      if (run.status === 'cancelling' && payload.type !== 'done' && payload.type !== 'error') return

      run.runId = payload.runId
      this.appendCanonicalAgentFacts(run, payload)
      this.syncAgentProjection(run)
      const workspaceStore = useWorkspaceStore()

      if (payload.type === 'run_started') {
        workspaceStore.updateAiAssistantMessageMetaInConversation(conversationId, run.assistantMessageId, {
          runId: payload.runId,
        }, { persist: false })
        return
      }

      if (payload.type === 'delta') {
        run.assistantText += payload.text || payload.content || ''
        workspaceStore.updateAiAssistantMessageTextInConversation(conversationId, run.assistantMessageId, run.assistantText, { persist: false })
        return
      }

      if (payload.type === 'done') {
        if (!run.assistantText.trim() && payload.answer?.trim()) run.assistantText = payload.answer.trim()
        this.completeAgentConversation(conversationId, payload.status)
        return
      }

      if (payload.type === 'error') {
        this.failAgentConversation(conversationId, payload.error.message || 'Agent 运行失败。', payload.error.technical_detail || undefined)
        return
      }

      if (payload.type === 'recovery_failed') {
        this.failAgentConversation(conversationId, payload.message || 'Agent 恢复失败。')
      }
    },

    completeAgentConversation(conversationId: string, status: 'completed' | 'cancelled') {
      const run = this.agentRunsByConversationId[conversationId]
      if (!run) return
      const finalStatus = status === 'cancelled' ? 'cancelled' : 'completed'
      const finalText = run.assistantText.trim() || (status === 'cancelled' ? '已取消本次 Agent 运行。' : 'Agent 没有返回可展示的回答。')
      const projection = this.syncAgentProjection(run)
      const workspaceStore = useWorkspaceStore()
      workspaceStore.updateAiAssistantMessageTextInConversation(conversationId, run.assistantMessageId, finalText, { persist: false })
      workspaceStore.updateAiAssistantMessageMetaInConversation(conversationId, run.assistantMessageId, {
        runId: run.runId,
        taskId: run.taskId,
        agentSummary: { status: finalStatus, toolCallCount: projection.toolCallCount, sourceCount: projection.sourceCount },
      }, { persist: true })
      delete this.agentRequestIdToConversationId[run.requestId]
      delete this.agentRunsByConversationId[conversationId]
    },

    failAgentConversation(conversationId: string, message: string, technicalDetail?: string) {
      const run = this.agentRunsByConversationId[conversationId]
      if (!run) return
      const friendlyMessage = compactText(message, 1000) || 'Agent 运行失败。'
      const compactTechnicalDetail = compactText(technicalDetail, 2000) || undefined
      const projection = this.syncAgentProjection(run)
      const workspaceStore = useWorkspaceStore()
      workspaceStore.updateAiAssistantMessageTextInConversation(conversationId, run.assistantMessageId, friendlyMessage, { persist: false })
      workspaceStore.updateAiAssistantMessageMetaInConversation(conversationId, run.assistantMessageId, {
        runId: run.runId,
        taskId: run.taskId,
        agentSummary: {
          status: 'error',
          toolCallCount: projection.toolCallCount,
          sourceCount: projection.sourceCount,
          error: { message: friendlyMessage, technicalDetail: compactTechnicalDetail },
        },
      }, { persist: true })
      delete this.agentRequestIdToConversationId[run.requestId]
      delete this.agentRunsByConversationId[conversationId]
    },

    async cancelAgentConversation(conversationId: string) {
      const preparing = this.agentStartingConversationIds[conversationId]
      if (preparing) {
        preparing.cancelled = true
        return { success: true }
      }
      const run = this.agentRunsByConversationId[conversationId]
      if (!run) return
      const requestId = run.requestId
      run.status = 'cancelling'
      try {
        const result = await (window as any).electronAPI.agent.runStream.cancel(requestId)
        if (!result?.success) {
          run.status = 'streaming'
          return { success: false, error: result?.error || '取消 Agent 运行失败。' }
        }
        if (Array.isArray(result.data?.agentEvents) && result.data.agentEvents.length) {
          this.appendCanonicalAgentFacts(run, {
            requestId,
            type: 'done',
            runId: run.runId || result.data.agentEvents[0].runId,
            status: 'cancelled',
            agentEvents: result.data.agentEvents,
          })
        }
        this.completeAgentConversation(conversationId, 'cancelled')
        return { success: true }
      } catch (error: any) {
        run.status = 'streaming'
        return { success: false, error: compactText(error?.message ?? String(error), 1000) || '取消 Agent 运行失败。' }
      }
    },

    async resolveAgentApproval(conversationId: string, approvalId: string, approved: boolean) {
      const run = this.agentRunsByConversationId[conversationId]
      const approval = this.getConversationAgentApprovals(conversationId)
        .find((item) => item.approvalId === approvalId)
      if (!run || !approval) return { success: false, error: '审批已失效。' }
      if (approval.status !== 'pending') return { success: false, error: '审批已经处理或正在处理中。' }
      if (Date.now() >= Date.parse(approval.deadlineAt)) {
        return { success: false, error: '审批已过期，请让 Agent 重新生成修改提案。' }
      }
      run.approvalResolutionInFlight[approvalId] = true
      try {
        const result = await (window as any).electronAPI.agent.resolveApproval(approvalId, approved)
        if (!result?.success) {
          delete run.approvalResolutionInFlight[approvalId]
          return { success: false, error: result?.error || '提交审批失败。' }
        }
        return { success: true }
      } catch (error: any) {
        delete run.approvalResolutionInFlight[approvalId]
        return { success: false, error: compactText(error?.message ?? String(error), 1000) || '提交审批失败。' }
      }
    },


    async summarizeConversationMessagesWithLlm(newMessages: RagChatMessagePayload[], options: { existingSummary?: string; maxChars: number }) {
      const summaryInput: RagChatMessagePayload[] = []
      if (options.existingSummary?.trim()) {
        summaryInput.push({ role: 'system', content: `上一版对话摘要：\n${options.existingSummary.trim()}` })
      }
      summaryInput.push(...flattenAgentHistoryForSummary(newMessages))
      if (!summaryInput.length) return ''

      const result = await (window as any).electronAPI.agent.summarizeConversation(summaryInput, options.maxChars)
      if (!result.success) throw new Error(result.error || '对话摘要生成失败。')
      return (result.data?.answer || '').trim()
    },

    async buildConversationHistoryForRequest(
      conversationId: string,
      currentQuestion: string,
      options?: { sourceMessages?: AiAssistantMessage[]; excludeMessageIds?: Set<number>; displaySummaryMessage?: boolean },
    ) {
      const settingsStore = useSettingsStore()
      const conversation = useWorkspaceStore().getAiAssistantConversationById(conversationId)
      const sourceMessages = options?.sourceMessages ?? conversation?.messages ?? []
      const excluded = options?.excludeMessageIds ?? new Set<number>()
      const contextSettings = settingsStore.aiSettings.conversationContext
      const normalizedAllMessages = normalizeConversationMessagesForContext(sourceMessages, excluded)
      const totalUserTurns = countUserTurns(normalizedAllMessages)
      const currentUserTurnIndex = totalUserTurns + 1

      if (contextSettings.strategy === 'sliding_window') {
        const history = selectRecentConversationMessages(normalizedAllMessages, contextSettings.recentTurns)
        const stats = buildConversationStats(currentQuestion, history, contextSettings.recentTurns, 0, false)
        return { history, stats }
      }

      const summaryIndex = findLatestConversationSummaryIndex(sourceMessages)
      const existingSummary = summaryIndex >= 0 ? getConversationSummaryContent(sourceMessages[summaryIndex].text) : ''
      const summarizedTurnIndex = summaryIndex >= 0 ? getConversationSummaryTurnIndex(sourceMessages[summaryIndex].text) : 0
      const messagesAfterSummary = summaryIndex >= 0 ? sourceMessages.slice(summaryIndex + 1) : sourceMessages
      const normalizedMessagesAfterSummary = normalizeConversationMessagesForContext(messagesAfterSummary, excluded)
      const unsummarizedUserTurns = Math.max(0, currentUserTurnIndex - summarizedTurnIndex)
      const retainedTurnCount = Math.max(1, Math.ceil(contextSettings.recentTurns / 4))
      const { messagesToSummarize, retainedMessages } = splitMessagesKeepingRecentTurns(normalizedMessagesAfterSummary, retainedTurnCount)
      const shouldSummarize = unsummarizedUserTurns > contextSettings.recentTurns && messagesToSummarize.length > 0

      let summaryContent = existingSummary
      let summaryTurnIndex = summarizedTurnIndex
      let contextTailMessages = normalizedMessagesAfterSummary
      let pendingSummaryMessageId: number | null = null

      if (shouldSummarize) {
        if (options?.displaySummaryMessage !== false) {
          pendingSummaryMessageId = useWorkspaceStore().appendAiAssistantMessageToConversation(conversationId, 'system', CONVERSATION_SUMMARY_PENDING_TEXT)
        }

        try {
          const nextSummary = await this.summarizeConversationMessagesWithLlm(messagesToSummarize, {
            existingSummary,

            maxChars: contextSettings.summaryMaxChars,
          })
          if (nextSummary) {
            summaryContent = nextSummary
            summaryTurnIndex = Math.max(summarizedTurnIndex, totalUserTurns - countUserTurns(retainedMessages))
            contextTailMessages = retainedMessages
            if (pendingSummaryMessageId) {
              useWorkspaceStore().updateAiAssistantMessageTextInConversation(
                conversationId,
                pendingSummaryMessageId,
                `${CONVERSATION_SUMMARY_PREFIX}（已总结至第 ${summaryTurnIndex} 次用户对话，保留最近 ${countUserTurns(retainedMessages)} 轮对话）\n\n${nextSummary}`,
              )
            }
          } else if (pendingSummaryMessageId) {
            useWorkspaceStore().updateAiAssistantMessageTextInConversation(conversationId, pendingSummaryMessageId, '系统：对话压缩完成，但模型没有返回可展示的摘要。')
          }
        } catch (error: any) {
          if (pendingSummaryMessageId) {
            useWorkspaceStore().updateAiAssistantMessageTextInConversation(
              conversationId,
              pendingSummaryMessageId,
              `系统：对话压缩失败，已改为携带上一版摘要和最近 ${contextSettings.recentTurns} 轮对话。\n\n${error?.message ?? String(error)}`,
            )
          }
          summaryContent = existingSummary
          summaryTurnIndex = summarizedTurnIndex
          contextTailMessages = normalizedMessagesAfterSummary
        }
      }

      const history: RagChatMessagePayload[] = summaryContent
        ? [{ role: 'system', content: `对话摘要（已总结至第 ${summaryTurnIndex} 次用户对话）：\n${summaryContent}` }, ...contextTailMessages]
        : contextTailMessages
      const stats = buildConversationStats(
        currentQuestion,
        history,
        contextSettings.recentTurns,
        shouldSummarize ? messagesToSummarize.length : 0,
        Boolean(summaryContent),
      )
      return { history, stats }
    },

    async cancelWorkspaceStreams(workspaceId: string | null) {
      if (!workspaceId) return
      const agentConversationIds = Object.values(this.agentRunsByConversationId as Record<string, AgentConversationRunState>)
        .filter((run) => run.workspaceId === workspaceId)
        .map((run) => run.conversationId)
      const preparingAgentConversationIds = Object.entries(this.agentStartingConversationIds as Record<string, ConversationPreparingState>)
        .filter(([, state]) => state.workspaceId === workspaceId)
        .map(([conversationId]) => conversationId)
      await Promise.all([
        ...agentConversationIds.map((conversationId) => this.cancelAgentConversation(conversationId)),
        ...preparingAgentConversationIds.map((conversationId) => this.cancelAgentConversation(conversationId)),
      ])
    },
  },
})

