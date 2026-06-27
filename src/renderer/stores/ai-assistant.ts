import { defineStore } from 'pinia'
import { useSettingsStore } from './settings'
import { useWorkspaceStore } from './workspace'
import type { AiAssistantMessage, AiAssistantTimelineOutput, AiAssistantTimelineStep } from './workspace'
import {
  applyRagTimelineEvent,
  createIndexTimeline,
  failAiTimelineStep,
  formatAiRuntimeError,
} from '../components/ai/aiTimeline'

type RagChatMessagePayload = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

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

type AiConversationStreamState = {
  requestId: string
  workspaceId: string
  conversationId: string
  assistantMessageId: number
  assistantText: string
  timeline: AiAssistantTimelineStep[]
  status: 'starting' | 'streaming' | 'done' | 'error' | 'cancelled'
  startedAt: number
  error?: string
}

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


const estimateTokenCount = (text: string) => {
  const normalized = text.trim()
  if (!normalized) return 0
  const cjkChars = normalized.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const nonCjkText = normalized.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
  const asciiTokenEstimate = Math.ceil(nonCjkText.replace(/\s+/g, ' ').trim().length / 4)
  return Math.max(1, cjkChars + asciiTokenEstimate)
}

const estimateMessageTokens = (message: RagChatMessagePayload) => estimateTokenCount(message.content) + 4

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

const normalizeConversationMessagesForContext = (sourceMessages: AiAssistantMessage[], excluded: Set<number>) =>
  sourceMessages
    .filter((message) => (
      (message.role === 'user' || message.role === 'assistant')
      && !excluded.has(message.id)
      && !message.actions?.length
      && message.createdAt !== 1
      && message.text.trim().length > 0
    ))
    .map((message): RagChatMessagePayload => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.text.trim(),
    }))

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

const normalizeTimelineSourcePath = (path?: string, workspacePath?: string) => {
  const value = (path || '').trim().replace(/\\+/g, '/')
  if (!value) return ''
  const normalizedWorkspacePath = workspacePath?.replace(/\\+/g, '/').replace(/\/+$/, '')
  if (normalizedWorkspacePath && value.toLowerCase().startsWith(`${normalizedWorkspacePath.toLowerCase()}/`)) {
    return value.slice(normalizedWorkspacePath.length + 1).replace(/^\/+/, '')
  }
  return value.replace(/^\/+/, '')
}

const createSourceOutputs = (sources: RagSourcePayload[], workspacePath?: string): AiAssistantTimelineOutput[] =>
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
      path: normalizeTimelineSourcePath(path, workspacePath),
      metadata: {
        ...source.metadata,
        score: source.score,
      },
    }
  })

export const useAiAssistantStore = defineStore('aiAssistant', {
  state: () => ({
    streamsByConversationId: {} as Record<string, AiConversationStreamState>,
    requestIdToConversationId: {} as Record<string, string>,
    subscribeStreamEvents: null as null | (() => void),
    indexStreamsByWorkspaceId: {} as Record<string, AiIndexStreamState>,
    indexRequestIdToWorkspaceId: {} as Record<string, string>,
    indexResultsByWorkspaceId: {} as Record<string, AiIndexResultState>,
    subscribeIndexStreamEvents: null as null | (() => void),
  }),
  getters: {
    isConversationAsking: (state) => (conversationId: string | null | undefined) => (
      Boolean(conversationId && state.streamsByConversationId[conversationId])
    ),
    getConversationStream: (state) => (conversationId: string | null | undefined) => (
      conversationId ? state.streamsByConversationId[conversationId] || null : null
    ),
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
      return `${Date.now()}:${Math.random().toString(36).slice(2)}`
    },

    ensureStreamEventSubscription() {
      if (this.subscribeStreamEvents) return
      this.subscribeStreamEvents = (window as any).electronAPI.rag.askStream.onEvent((payload: RagStreamEventPayload) => {
        this.handleStreamEvent(payload)
      })
    },

    disposeStreamEventSubscription() {
      this.subscribeStreamEvents?.()
      this.subscribeStreamEvents = null
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


    async summarizeConversationMessagesWithLlm(newMessages: RagChatMessagePayload[], options: { existingSummary?: string; maxChars: number }) {
      const summaryInput: RagChatMessagePayload[] = []
      if (options.existingSummary?.trim()) {
        summaryInput.push({ role: 'system', content: `上一版对话摘要：\n${options.existingSummary.trim()}` })
      }
      summaryInput.push(...newMessages)
      if (!summaryInput.length) return ''

      const result = await (window as any).electronAPI.rag.summarizeConversation(summaryInput, options.maxChars)
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
      const summarizedTurnIndex = summaryIndex ? getConversationSummaryTurnIndex(sourceMessages[summaryIndex].text) : 0
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

    async askInConversation(options: { workspaceId: string; conversationId?: string; text: string; aiName: string }) {
      const text = options.text.trim()
      if (!options.workspaceId || !text) return { success: false, error: 'Question is required' }

      this.ensureStreamEventSubscription()
      const conversationId = options.conversationId || useWorkspaceStore().ensureAiAssistantConversationForRequest()
      if (this.streamsByConversationId[conversationId]) return { success: false, error: '当前会话正在生成，请等待完成或停止后再发送。' }
      if (!useWorkspaceStore().getAiAssistantConversationById(conversationId)) return { success: false, error: 'Conversation not found' }

      const { history, stats } = await this.buildConversationHistoryForRequest(conversationId, text)
      useWorkspaceStore().setAiAssistantDraft('')
      useWorkspaceStore().appendAiAssistantMessageToConversation(conversationId, 'user', text)
      const assistantMessageId = useWorkspaceStore().appendAiAssistantMessageToConversation(conversationId, 'assistant', '', undefined, { aiName: options.aiName })
      if (!assistantMessageId) return { success: false, error: 'Assistant message could not be created' }

      const requestId = this.createStreamRequestId()
      const timeline = createConversationContextTimeline(stats)
      this.streamsByConversationId[conversationId] = {
        requestId,
        workspaceId: options.workspaceId,
        conversationId,
        assistantMessageId,
        assistantText: '',
        timeline,
        status: 'starting',
        startedAt: Date.now(),
      }
      this.requestIdToConversationId[requestId] = conversationId
      useWorkspaceStore().updateAiAssistantMessageTextInConversation(conversationId, assistantMessageId, '', { persist: false })
      useWorkspaceStore().updateAiAssistantMessageTimelineInConversation(conversationId, assistantMessageId, timeline, { persist: true })

      try {
        const result = await (window as any).electronAPI.rag.askStream.start(requestId, options.workspaceId, text, history, stats)
        if (!result.success) {
          const errorText = result.error || 'AI 助手请求失败。'
          this.failConversationStream(conversationId, errorText, 'start-request')
          return result
        }
        const stream = this.streamsByConversationId[conversationId]
        if (stream) stream.status = 'streaming'
        return { success: true }
      } catch (error: any) {
        const errorText = `AI 助手请求失败：${error?.message ?? String(error)}`
        this.failConversationStream(conversationId, errorText, 'start-request')
        return { success: false, error: errorText }
      }
    },

    async regenerateInConversation(options: {
      workspaceId: string
      conversationId: string
      text: string
      assistantMessageId: number
      sourceMessages: AiAssistantMessage[]
      aiName: string
    }) {
      const text = options.text.trim()
      if (!options.workspaceId || !options.conversationId || !text) return { success: false, error: 'Question is required' }
      if (this.streamsByConversationId[options.conversationId]) return { success: false, error: '当前会话正在生成，请等待完成或停止后再重新生成。' }

      this.ensureStreamEventSubscription()
      useWorkspaceStore().updateAiAssistantMessageTextInConversation(options.conversationId, options.assistantMessageId, '', { persist: false })
      useWorkspaceStore().updateAiAssistantMessageMetaInConversation(options.conversationId, options.assistantMessageId, { aiName: options.aiName })
      const { history, stats } = await this.buildConversationHistoryForRequest(options.conversationId, text, {
        sourceMessages: options.sourceMessages,
        displaySummaryMessage: false,
      })
      const requestId = this.createStreamRequestId()
      const timeline = createConversationContextTimeline(stats)
      this.streamsByConversationId[options.conversationId] = {
        requestId,
        workspaceId: options.workspaceId,
        conversationId: options.conversationId,
        assistantMessageId: options.assistantMessageId,
        assistantText: '',
        timeline,
        status: 'starting',
        startedAt: Date.now(),
      }
      this.requestIdToConversationId[requestId] = options.conversationId
      useWorkspaceStore().updateAiAssistantMessageTimelineInConversation(options.conversationId, options.assistantMessageId, timeline, { persist: true })

      try {
        const result = await (window as any).electronAPI.rag.askStream.start(requestId, options.workspaceId, text, history, stats)
        if (!result.success) {
          const errorText = result.error || 'AI 助手请求失败。'
          this.failConversationStream(options.conversationId, errorText, 'start-request')
          return result
        }
        const stream = this.streamsByConversationId[options.conversationId]
        if (stream) stream.status = 'streaming'
        return { success: true }
      } catch (error: any) {
        const errorText = `AI 助手请求失败：${error?.message ?? String(error)}`
        this.failConversationStream(options.conversationId, errorText, 'start-request')
        return { success: false, error: errorText }
      }
    },

    handleStreamEvent(payload: RagStreamEventPayload) {
      const conversationId = this.requestIdToConversationId[payload.requestId]
      if (!conversationId) return
      const stream = this.streamsByConversationId[conversationId]
      if (!stream || stream.requestId !== payload.requestId) return

      if (payload.type === 'timeline' || payload.type === 'progress') {
        stream.timeline = applyRagTimelineEvent(stream.timeline, payload as any)
        useWorkspaceStore().updateAiAssistantMessageTimelineInConversation(conversationId, stream.assistantMessageId, stream.timeline, { persist: false })
        return
      }

      if (payload.type === 'sources') {
        const sources = payload.sources || []
        stream.timeline = applyRagTimelineEvent(stream.timeline, {
          type: 'timeline',
          stepId: 'retrieve-context',
          title: '检索上下文',
          status: 'completed',
          detail: sources.length ? `命中 ${sources.length} 个相关片段。` : '未收到可展示的来源片段。',
          outputs: createSourceOutputs(sources, useWorkspaceStore().activeWorkspace?.path || ''),
        })
        useWorkspaceStore().updateAiAssistantMessageTimelineInConversation(conversationId, stream.assistantMessageId, stream.timeline, { persist: false })
        return
      }

      if (payload.type === 'delta') {
        if (!stream.assistantText.trim()) {
          stream.timeline = applyRagTimelineEvent(stream.timeline, {
            type: 'timeline',
            stepId: 'compose-answer',
            title: '生成回复',
            status: 'active',
            detail: '正在流式生成最终回答。',
            outputs: [{ type: 'text', title: '生成回复', content: '正在流式生成最终回答。' }],
          })
          useWorkspaceStore().updateAiAssistantMessageTimelineInConversation(conversationId, stream.assistantMessageId, stream.timeline, { persist: false })
        }
        stream.assistantText += payload.text
        useWorkspaceStore().updateAiAssistantMessageTextInConversation(conversationId, stream.assistantMessageId, stream.assistantText, { persist: false })
        return
      }

      if (payload.type === 'done') {
        this.completeConversationStream(conversationId)
        return
      }

      if (payload.type === 'error') {
        this.failConversationStream(conversationId, payload.error || 'AI 助手请求失败。', payload.stepId || 'compose-answer')
      }
    },

    completeConversationStream(conversationId: string) {
      const stream = this.streamsByConversationId[conversationId]
      if (!stream) return
      stream.timeline = applyRagTimelineEvent(stream.timeline, {
        type: 'timeline',
        stepId: 'compose-answer',
        title: '生成回复',
        status: 'completed',
        detail: stream.assistantText.trim() ? '最终回复已生成。' : '没有得到可展示的回复。',
      })
      useWorkspaceStore().updateAiAssistantMessageTimelineInConversation(conversationId, stream.assistantMessageId, stream.timeline, { persist: true })
      useWorkspaceStore().updateAiAssistantMessageTextInConversation(conversationId, stream.assistantMessageId, stream.assistantText.trim() ? stream.assistantText : '没有得到回答。')
      stream.status = 'done'
      delete this.requestIdToConversationId[stream.requestId]
      delete this.streamsByConversationId[conversationId]
    },

    failConversationStream(conversationId: string, error: string, stepId = 'compose-answer') {
      const stream = this.streamsByConversationId[conversationId]
      if (!stream) return
      const runtimeError = formatAiRuntimeError(error, 'AI 助手请求失败。')
      stream.timeline = failAiTimelineStep(stream.timeline, stepId, runtimeError.message, Date.now(), runtimeError.technicalDetail)
      useWorkspaceStore().updateAiAssistantMessageTimelineInConversation(conversationId, stream.assistantMessageId, stream.timeline, { persist: true })
      if (stream.assistantText.trim()) {
        useWorkspaceStore().appendAiAssistantMessageToConversation(conversationId, 'system', runtimeError.message)
      } else {
        useWorkspaceStore().updateAiAssistantMessageTextInConversation(conversationId, stream.assistantMessageId, runtimeError.message)
      }
      stream.status = 'error'
      stream.error = runtimeError.message
      delete this.requestIdToConversationId[stream.requestId]
      delete this.streamsByConversationId[conversationId]
    },

    async cancelConversation(conversationId: string) {
      const stream = this.streamsByConversationId[conversationId]
      if (!stream) return
      await (window as any).electronAPI.rag.askStream.cancel(stream.requestId).catch(() => {})
      stream.status = 'cancelled'
      delete this.requestIdToConversationId[stream.requestId]
      delete this.streamsByConversationId[conversationId]
    },

    async cancelWorkspaceStreams(workspaceId: string | null) {
      if (!workspaceId) return
      const conversationIds = Object.values(this.streamsByConversationId as Record<string, AiConversationStreamState>)
        .filter((stream) => stream.workspaceId === workspaceId)
        .map((stream) => stream.conversationId)
      await Promise.all(conversationIds.map((conversationId) => this.cancelConversation(conversationId)))
    },
  },
})
