<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Bot, Clipboard, Copy, FileText, History, Loader2, MessageSquare, Paperclip, Plus, RotateCcw, Send, Settings, Sparkles, Trash2, User } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import { useSettingsStore } from '@/renderer/stores/settings'
import type { AiAssistantMessage, AiAssistantMessageAction, AiAssistantTimelineOutput, AiAssistantTimelineStep } from '@/renderer/stores/workspace'
import AiMarkdown from './AiMarkdown.vue'
import { applyRagTimelineEvent, createIndexTimeline, failAiTimelineStep, formatAiRuntimeError, getAiTimelineStepDuration } from './aiTimeline'

const workspaceStore = useWorkspaceStore()
const settingsStore = useSettingsStore()
const BUILD_INDEX_ACTION_TYPE: AiAssistantMessageAction['type'] = 'build-index'
const MISSING_INDEX_MESSAGE = '为了让 Looma AI 能检索你的笔记，需要先为当前工作空间建立本地索引。这个提示来自应用状态，不是 AI 回答。'
const isIndexing = ref(false)
const isAsking = ref(false)
const isCheckingIndex = ref(false)
const hasIndex = ref(false)
const messagesRef = ref<HTMLElement | null>(null)
const composerRef = ref<HTMLTextAreaElement | null>(null)
const contextMenuRef = ref<HTMLElement | null>(null)
const activeStreamRequestId = ref<string | null>(null)
const activeAssistantMessageId = ref<number | null>(null)
const activeAssistantText = ref('')
const activeAssistantTimeline = ref<AiAssistantTimelineStep[]>([])
const activeIndexRequestId = ref<string | null>(null)
const activeIndexMessageId = ref<number | null>(null)
const activeIndexTimeline = ref<AiAssistantTimelineStep[]>([])
const copiedMessageId = ref<number | null>(null)
const historyOpen = ref(false)
const aiContextMenu = ref({
  visible: false,
  top: 0,
  left: 0,
  source: null as 'messages' | 'composer' | null,
  selectedText: '',
})
let unsubscribeStreamEvents: (() => void) | null = null
let unsubscribeIndexStreamEvents: (() => void) | null = null

const hasWorkspace = computed(() => Boolean(workspaceStore.activeWorkspaceId))
const activeConversation = computed(() => workspaceStore.activeAiAssistantConversation)
const activeConversationId = computed(() => workspaceStore.aiAssistant.activeConversationId)
const conversations = computed(() => workspaceStore.aiAssistantConversations)
const messages = computed(() => activeConversation.value.messages)
const question = computed({
  get: () => activeConversation.value.draft,
  set: (value: string) => workspaceStore.setAiAssistantDraft(value),
})
const canAsk = computed(() => hasWorkspace.value && hasIndex.value && !isCheckingIndex.value && !isIndexing.value && !isAsking.value && question.value.trim().length > 0)
const canAskWithText = computed(() => hasWorkspace.value && hasIndex.value && !isCheckingIndex.value && !isIndexing.value && !isAsking.value)
const inputPlaceholder = computed(() => {
  if (!hasWorkspace.value) return '请先打开工作空间'
  if (isCheckingIndex.value) return '正在检查索引...'
  if (!hasIndex.value) return '请先建立索引'
  if (isIndexing.value) return '正在建立索引...'
  if (isAsking.value) return '正在思考...'
  return '询问当前工作空间中的笔记'
})
const providerLabels: Record<string, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI Compatible',
  deepseek: 'DeepSeek',
  qwen: '通义千问',
  custom: '自定义 HTTP API',
}
const aiDisplayName = computed(() => {
  const chat = settingsStore.aiSettings.chat
  const provider = providerLabels[chat.provider] ?? chat.provider
  const model = chat.model?.trim() || '未选择模型'
  return `${provider} · ${model}`
})
const getMessageAiName = (message: { aiName?: string }) => message.aiName?.trim() || 'Looma AI'

const scrollToBottom = () => {
  nextTick(() => {
    messagesRef.value?.scrollTo({ top: messagesRef.value.scrollHeight, behavior: 'smooth' })
  })
}

const appendMessage = (role: 'assistant' | 'user' | 'system', text: string, actions?: AiAssistantMessageAction[], meta?: { aiName?: string }) => {
  const id = workspaceStore.appendAiAssistantMessage(role, text, actions, meta)
  scrollToBottom()
  return id
}

const appendToDraft = (text: string) => {
  const value = text.trim()
  if (!value) return
  const current = question.value.trimEnd()
  question.value = current ? `${current}\n\n${value}` : value
  nextTick(() => composerRef.value?.focus())
}

const closeAiContextMenu = () => {
  aiContextMenu.value.visible = false
}

const getContainedSelectionText = (container: HTMLElement | null) => {
  if (!container) return ''
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return ''

  const range = selection.getRangeAt(0)
  const ancestor = range.commonAncestorContainer
  const node = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement
  if (!node || !container.contains(node)) return ''

  return selection.toString().trim()
}

const getComposerSelectedText = () => {
  const textarea = composerRef.value
  if (!textarea) return ''
  const start = textarea.selectionStart ?? 0
  const end = textarea.selectionEnd ?? 0
  if (start === end) return ''
  return textarea.value.slice(Math.min(start, end), Math.max(start, end)).trim()
}

const positionAiContextMenu = (event: MouseEvent) => {
  aiContextMenu.value.left = event.clientX
  aiContextMenu.value.top = event.clientY

  nextTick(() => {
    const menu = contextMenuRef.value
    if (!menu || !aiContextMenu.value.visible) return

    const rect = menu.getBoundingClientRect()
    const margin = 8
    aiContextMenu.value.left = Math.min(event.clientX, window.innerWidth - rect.width - margin)
    aiContextMenu.value.top = Math.min(event.clientY, window.innerHeight - rect.height - margin)
    aiContextMenu.value.left = Math.max(margin, aiContextMenu.value.left)
    aiContextMenu.value.top = Math.max(margin, aiContextMenu.value.top)
  })
}

const openMessagesContextMenu = (event: MouseEvent) => {
  const selectedText = getContainedSelectionText(messagesRef.value)
  if (!selectedText) return

  event.preventDefault()
  aiContextMenu.value = {
    visible: true,
    top: event.clientY,
    left: event.clientX,
    source: 'messages',
    selectedText,
  }
  positionAiContextMenu(event)
}

const openComposerContextMenu = (event: MouseEvent) => {
  event.preventDefault()
  aiContextMenu.value = {
    visible: true,
    top: event.clientY,
    left: event.clientX,
    source: 'composer',
    selectedText: getComposerSelectedText(),
  }
  positionAiContextMenu(event)
}

const copySelectedContextText = async () => {
  const text = aiContextMenu.value.selectedText.trim()
  if (!text) return
  await navigator.clipboard.writeText(text)
  closeAiContextMenu()
}

const pasteIntoComposer = async () => {
  if (aiContextMenu.value.source !== 'composer') return
  const text = await navigator.clipboard.readText()
  appendToDraft(text)
  closeAiContextMenu()
}

const addSelectionToComposer = () => {
  if (aiContextMenu.value.source !== 'messages') return
  appendToDraft(aiContextMenu.value.selectedText)
  closeAiContextMenu()
}

const explainSelection = async () => {
  if (aiContextMenu.value.source !== 'messages') return
  const selectedText = aiContextMenu.value.selectedText.trim()
  if (!selectedText) return

  const prompt = `请解释以下内容：\n\n${selectedText}`
  closeAiContextMenu()

  if (!canAskWithText.value) {
    appendToDraft(prompt)
    return
  }

  question.value = prompt
  await nextTick()
  askQuestion().catch(console.error)
}

const handleDocumentClick = (event: MouseEvent) => {
  if (!aiContextMenu.value.visible) return
  if (contextMenuRef.value?.contains(event.target as Node)) return
  closeAiContextMenu()
}

const formatConversationTime = (timestamp: number) => {
  if (!Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return new Intl.DateTimeFormat('zh-CN', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: '2-digit', day: '2-digit' }).format(date)
}

const clearActiveStream = () => {
  activeStreamRequestId.value = null
  activeAssistantMessageId.value = null
  activeAssistantText.value = ''
  activeAssistantTimeline.value = []
}

const clearActiveIndexStream = () => {
  activeIndexRequestId.value = null
  activeIndexMessageId.value = null
  activeIndexTimeline.value = []
}

const syncActiveTimeline = (timeline: AiAssistantTimelineStep[], options?: { persist?: boolean }) => {
  const messageId = activeAssistantMessageId.value
  if (!messageId) return
  activeAssistantTimeline.value = timeline
  workspaceStore.updateAiAssistantMessageTimeline(messageId, timeline, options ?? { persist: false })
}

const updateActiveTimeline = (
  updater: (timeline: AiAssistantTimelineStep[]) => AiAssistantTimelineStep[],
  options?: { persist?: boolean },
) => {
  if (!activeAssistantTimeline.value.length) return
  syncActiveTimeline(updater(activeAssistantTimeline.value), options)
}

const syncActiveIndexTimeline = (timeline: AiAssistantTimelineStep[], options?: { persist?: boolean }) => {
  const messageId = activeIndexMessageId.value
  if (!messageId) return
  activeIndexTimeline.value = timeline
  workspaceStore.updateAiAssistantMessageTimeline(messageId, timeline, options ?? { persist: false })
}

const updateActiveIndexTimeline = (
  updater: (timeline: AiAssistantTimelineStep[]) => AiAssistantTimelineStep[],
  options?: { persist?: boolean },
) => {
  if (!activeIndexTimeline.value.length) return
  syncActiveIndexTimeline(updater(activeIndexTimeline.value), options)
}

const cancelActiveStream = () => {
  const requestId = activeStreamRequestId.value
  if (requestId) {
    window.electronAPI.rag.askStream.cancel(requestId).catch(() => {})
  }
  clearActiveStream()
}

const cancelActiveIndexStream = () => {
  const requestId = activeIndexRequestId.value
  if (requestId) {
    window.electronAPI.rag.indexStream.cancel(requestId).catch(() => {})
  }
  clearActiveIndexStream()
}

const createStreamRequestId = () =>
  `${Date.now()}:${Math.random().toString(36).slice(2)}`

const getTimelineStatusClass = (status: AiAssistantTimelineStep['status']) => {
  if (status === 'active') return 'bg-accent'
  if (status === 'completed') return 'bg-text-subtle'
  if (status === 'error') return 'bg-danger'
  return 'bg-border-soft'
}

const getTimelineStatusLabel = (status: AiAssistantTimelineStep['status']) => {
  if (status === 'active') return '进行中'
  if (status === 'completed') return '完成'
  if (status === 'error') return '失败'
  return '等待'
}

const getTimelineOutputText = (output: AiAssistantTimelineOutput) => {
  if (output.content) return output.content
  if (output.path) return output.path
  if (output.value !== undefined) return `${output.value}${output.unit || ''}`
  if (output.metadata) return JSON.stringify(output.metadata)
  return ''
}

const normalizeTimelineSourcePath = (path?: string) => {
  const value = (path || '').trim().replace(/\\+/g, '/')
  if (!value) return ''
  const workspacePath = workspaceStore.activeWorkspace?.path?.replace(/\\+/g, '/').replace(/\/+$/, '')
  if (workspacePath && value.toLowerCase().startsWith(`${workspacePath.toLowerCase()}/`)) {
    return value.slice(workspacePath.length + 1).replace(/^\/+/, '')
  }
  return value.replace(/^\/+/, '')
}

const getTimelineSourcePath = (output: AiAssistantTimelineOutput) => {
  const metadata = output.metadata || {}
  const path = output.path
    || (typeof metadata.source === 'string' ? metadata.source : '')
    || (typeof metadata.file_path === 'string' ? metadata.file_path : '')
    || (typeof metadata.path === 'string' ? metadata.path : '')
  return normalizeTimelineSourcePath(path)
}

const getTimelineSourceName = (output: AiAssistantTimelineOutput) => {
  const path = getTimelineSourcePath(output)
  if (!path) return output.title || '检索片段'
  return path.split('/').filter(Boolean).pop() || path
}

const getTimelineSourceScore = (output: AiAssistantTimelineOutput) => {
  const score = output.metadata?.score
  if (typeof score !== 'number' || !Number.isFinite(score)) return ''
  return score >= 0 && score <= 1 ? `${Math.round(score * 100)}%` : score.toFixed(3)
}

const openTimelineSource = (output: AiAssistantTimelineOutput) => {
  const path = getTimelineSourcePath(output)
  if (!path) return
  workspaceStore.setActiveFileRelative(path)
}

const createSourceOutputs = (sources: Array<{ score: number | null; text: string; metadata: Record<string, unknown> }>): AiAssistantTimelineOutput[] =>
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
      path,
      metadata: {
        ...source.metadata,
        score: source.score,
      },
    }
  })

type RagChatMessagePayload = {
  role: 'user' | 'assistant'
  content: string
}

type RagRequestStatsPayload = {
  history_messages: number
  history_token_estimate: number
  question_token_estimate: number
  total_token_estimate: number
}

const estimateTokenCount = (text: string) => {
  const normalized = text.trim()
  if (!normalized) return 0
  const cjkChars = normalized.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const nonCjkText = normalized.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
  const asciiTokenEstimate = Math.ceil(nonCjkText.replace(/\s+/g, ' ').trim().length / 4)
  return Math.max(1, cjkChars + asciiTokenEstimate)
}

const estimateMessageTokens = (message: RagChatMessagePayload) =>
  estimateTokenCount(message.content) + 4

const buildConversationHistoryForRequest = (
  currentQuestion: string,
  options?: {
    sourceMessages?: AiAssistantMessage[]
    excludeMessageIds?: Set<number>
  },
) => {
  const excluded = options?.excludeMessageIds ?? new Set<number>()
  const history = (options?.sourceMessages ?? messages.value)
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

  const historyTokenEstimate = history.reduce((total, message) => total + estimateMessageTokens(message), 0)
  const questionTokenEstimate = estimateTokenCount(currentQuestion) + 4
  const stats: RagRequestStatsPayload = {
    history_messages: history.length,
    history_token_estimate: historyTokenEstimate,
    question_token_estimate: questionTokenEstimate,
    total_token_estimate: historyTokenEstimate + questionTokenEstimate,
  }

  return { history, stats }
}

const createConversationContextTimeline = (stats: RagRequestStatsPayload, startedAt = Date.now()): AiAssistantTimelineStep[] => [{
  id: 'conversation-context',
  title: '整理对话上下文',
  description: '把当前会话历史转换为后端 history，并估算本次请求上下文 token。',
  detail: `已加入 ${stats.history_messages} 条历史消息，整轮上下文约 ${stats.total_token_estimate} tokens。`,
  status: 'completed',
  startedAt,
  endedAt: startedAt,
  outputs: [
    {
      id: 'history-messages',
      type: 'metric',
      title: '历史消息',
      value: stats.history_messages,
      unit: '条',
    },
    {
      id: 'history-token-estimate',
      type: 'metric',
      title: '历史上下文',
      value: stats.history_token_estimate,
      unit: ' tokens',
    },
    {
      id: 'question-token-estimate',
      type: 'metric',
      title: '当前问题',
      value: stats.question_token_estimate,
      unit: ' tokens',
    },
    {
      id: 'total-token-estimate',
      type: 'metric',
      title: '会话总计',
      value: stats.total_token_estimate,
      unit: ' tokens',
    },
  ],
}]

const handleStreamEvent = (payload: Parameters<Parameters<typeof window.electronAPI.rag.askStream.onEvent>[0]>[0]) => {
  if (!activeStreamRequestId.value || payload.requestId !== activeStreamRequestId.value) return
  const messageId = activeAssistantMessageId.value
  if (!messageId) return

  if (payload.type === 'timeline' || payload.type === 'progress') {
    updateActiveTimeline((timeline) => applyRagTimelineEvent(timeline, payload))
    scrollToBottom()
    return
  }

  if (payload.type === 'sources') {
    const sources = payload.sources || []
    updateActiveTimeline((timeline) => applyRagTimelineEvent(timeline, {
      type: 'timeline',
      stepId: 'retrieve-context',
      title: '检索上下文',
      status: 'completed',
      detail: sources.length ? `命中 ${sources.length} 个相关片段。` : '未收到可展示的来源片段。',
      outputs: createSourceOutputs(sources),
    }))
    scrollToBottom()
    return
  }

  if (payload.type === 'delta') {
    if (!activeAssistantText.value.trim()) {
      updateActiveTimeline((timeline) => applyRagTimelineEvent(timeline, {
        type: 'timeline',
        stepId: 'compose-answer',
        title: '生成回复',
        status: 'active',
        detail: '正在流式生成最终回答。',
        outputs: [{
          type: 'text',
          title: '生成回复',
          content: '正在流式生成最终回答。',
        }],
      }))
    }
    activeAssistantText.value += payload.text
    workspaceStore.updateAiAssistantMessageText(messageId, activeAssistantText.value, { persist: false })
    scrollToBottom()
    return
  }

  if (payload.type === 'done') {
    updateActiveTimeline((timeline) => applyRagTimelineEvent(timeline, {
      type: 'timeline',
      stepId: 'compose-answer',
      title: '生成回复',
      status: 'completed',
      detail: activeAssistantText.value.trim() ? '最终回复已生成。' : '没有得到可展示的回复。',
    }))
    if (!activeAssistantText.value.trim()) {
      workspaceStore.updateAiAssistantMessageText(messageId, '没有得到回答。')
    } else {
      workspaceStore.updateAiAssistantMessageText(messageId, activeAssistantText.value)
    }
    isAsking.value = false
    clearActiveStream()
    scrollToBottom()
    return
  }

  if (payload.type === 'error') {
    const runtimeError = formatAiRuntimeError(payload.error, 'AI 助手请求失败。')
    updateActiveTimeline((timeline) => failAiTimelineStep(timeline, payload.stepId || 'compose-answer', runtimeError.message, Date.now(), runtimeError.technicalDetail))
    if (activeAssistantText.value.trim()) {
      appendMessage('system', runtimeError.message)
    } else {
      workspaceStore.updateAiAssistantMessageText(messageId, runtimeError.message)
    }
    isAsking.value = false
    clearActiveStream()
    scrollToBottom()
  }
}

const handleIndexStreamEvent = (payload: Parameters<Parameters<typeof window.electronAPI.rag.indexStream.onEvent>[0]>[0]) => {
  if (!activeIndexRequestId.value || payload.requestId !== activeIndexRequestId.value) return
  const messageId = activeIndexMessageId.value
  if (!messageId) return

  if (payload.type === 'timeline' || payload.type === 'progress') {
    updateActiveIndexTimeline((timeline) => applyRagTimelineEvent(timeline, payload))
    scrollToBottom()
    return
  }

  if (payload.type === 'done') {
    const result = payload.result || payload
    const count = typeof result.document_count === 'number' ? result.document_count : 0
    const exists = Boolean(result.exists)
    hasIndex.value = exists && count > 0
    setBuildIndexActionsDisabled(hasIndex.value)
    workspaceStore.updateAiAssistantMessageText(
      messageId,
      count === 0
        ? '当前工作空间没有可索引的文档，请添加 Markdown、文本或 PDF 文件后再建立索引。'
        : `索引已建立，共处理 ${count} 个文档。现在可以开始提问。`,
    )
    isIndexing.value = false
    clearActiveIndexStream()
    scrollToBottom()
    return
  }

  if (payload.type === 'error') {
    const runtimeError = formatAiRuntimeError(payload.error, '建立索引失败。')
    updateActiveIndexTimeline((timeline) => failAiTimelineStep(timeline, payload.stepId || 'verify-index', runtimeError.message, Date.now(), runtimeError.technicalDetail))
    workspaceStore.updateAiAssistantMessageText(messageId, `建立索引失败：${runtimeError.message}`)
    hasIndex.value = false
    setBuildIndexActionsDisabled(false)
    isIndexing.value = false
    clearActiveIndexStream()
    scrollToBottom()
  }
}

const getActiveWorkspaceId = () => {
  const workspaceId = workspaceStore.activeWorkspaceId
  if (!workspaceId) {
    appendMessage('system', '请先打开一个工作空间。')
    return null
  }
  return workspaceId
}

const createBuildIndexAction = (disabled = false): AiAssistantMessageAction => ({
  type: BUILD_INDEX_ACTION_TYPE,
  title: '建立当前工作空间索引',
  description: '索引只保存在本机。建立完成后，Looma AI 就可以基于当前工作空间回答你的问题。',
  buttonText: '建立索引',
  disabled,
})

const hasBuildIndexPrompt = () =>
  messages.value.some((message) =>
    message.text === MISSING_INDEX_MESSAGE
    || message.actions?.some((action) => action.type === BUILD_INDEX_ACTION_TYPE),
  )

const ensureBuildIndexPrompt = () => {
  if (hasBuildIndexPrompt()) return
  appendMessage('system', MISSING_INDEX_MESSAGE, [createBuildIndexAction(false)])
}

const setBuildIndexActionsDisabled = (disabled: boolean) => {
  workspaceStore.setAiAssistantActionDisabled(BUILD_INDEX_ACTION_TYPE, disabled)
}

const checkIndexStatus = async () => {
  const workspaceId = workspaceStore.activeWorkspaceId
  hasIndex.value = false
  if (!workspaceId) return

  isCheckingIndex.value = true
  try {
    const result = await window.electronAPI.rag.status(workspaceId)
    if (workspaceStore.activeWorkspaceId !== workspaceId) return
    if (!result.success) {
      setBuildIndexActionsDisabled(false)
      ensureBuildIndexPrompt()
      console.warn(result.error || '检查索引状态失败。')
      return
    }

    hasIndex.value = Boolean(result.data?.exists)
    if (hasIndex.value) {
      setBuildIndexActionsDisabled(true)
    } else {
      setBuildIndexActionsDisabled(false)
      ensureBuildIndexPrompt()
    }
  } finally {
    isCheckingIndex.value = false
  }
}

const indexWorkspace = async () => {
  const workspaceId = getActiveWorkspaceId()
  if (!workspaceId || isIndexing.value || hasIndex.value) return

  isIndexing.value = true
  setBuildIndexActionsDisabled(true)
  const messageId = appendMessage('assistant', '正在建立当前工作空间索引...')
  const requestId = createStreamRequestId()
  activeIndexRequestId.value = requestId
  activeIndexMessageId.value = messageId
  syncActiveIndexTimeline(createIndexTimeline(Date.now()))

  try {
    const result = await window.electronAPI.rag.indexStream.start(requestId, workspaceId)
    if (!result.success) {
      const runtimeError = formatAiRuntimeError(result.error, '建立索引失败。')
      updateActiveIndexTimeline((timeline) => failAiTimelineStep(timeline, 'validate-workspace', runtimeError.message, Date.now(), runtimeError.technicalDetail))
      workspaceStore.updateAiAssistantMessageText(messageId, `建立索引失败：${runtimeError.message}`)
      hasIndex.value = false
      setBuildIndexActionsDisabled(false)
      clearActiveIndexStream()
      isIndexing.value = false
    }
  } catch (error: any) {
    const runtimeError = formatAiRuntimeError(error?.message ?? String(error), '建立索引失败。')
    updateActiveIndexTimeline((timeline) => failAiTimelineStep(timeline, 'validate-workspace', runtimeError.message, Date.now(), runtimeError.technicalDetail))
    workspaceStore.updateAiAssistantMessageText(messageId, `建立索引失败：${runtimeError.message}`)
    hasIndex.value = false
    setBuildIndexActionsDisabled(false)
    clearActiveIndexStream()
    isIndexing.value = false
  }
}

const startAssistantRequest = async (
  workspaceId: string,
  text: string,
  assistantMessageId: number,
  history: RagChatMessagePayload[],
  stats: RagRequestStatsPayload,
) => {
  const requestId = createStreamRequestId()
  activeStreamRequestId.value = requestId
  activeAssistantMessageId.value = assistantMessageId
  activeAssistantText.value = ''
  workspaceStore.updateAiAssistantMessageText(assistantMessageId, '', { persist: false })
  syncActiveTimeline(createConversationContextTimeline(stats), { persist: true })
  scrollToBottom()

  try {
    const result = await window.electronAPI.rag.askStream.start(requestId, workspaceId, text, history, stats)
    if (!result.success) {
      const errorText = result.error || 'AI 助手请求失败。'
      updateActiveTimeline((timeline) => failAiTimelineStep(timeline, 'start-request', errorText))
      workspaceStore.updateAiAssistantMessageText(assistantMessageId, errorText)
      clearActiveStream()
      isAsking.value = false
      return
    }
  } catch (error: any) {
    const errorText = `AI 助手请求失败：${error?.message ?? String(error)}`
    updateActiveTimeline((timeline) => failAiTimelineStep(timeline, 'start-request', errorText))
    workspaceStore.updateAiAssistantMessageText(assistantMessageId, errorText)
    clearActiveStream()
    isAsking.value = false
  }
}

const askQuestion = async () => {
  const workspaceId = getActiveWorkspaceId()
  const text = question.value.trim()
  if (!workspaceId || !text || isAsking.value) return
  if (!hasIndex.value) {
    ensureBuildIndexPrompt()
    return
  }

  const assistantName = aiDisplayName.value
  const { history, stats } = buildConversationHistoryForRequest(text)
  workspaceStore.setAiAssistantDraft('')
  isAsking.value = true
  appendMessage('user', text)
  const assistantMessageId = appendMessage('assistant', '', undefined, { aiName: assistantName })
  await startAssistantRequest(workspaceId, text, assistantMessageId, history, stats)
}

const copyAssistantMessage = async (message: AiAssistantMessage) => {
  const text = message.text.trim()
  if (!text) return

  try {
    await navigator.clipboard.writeText(text)
    copiedMessageId.value = message.id
    window.setTimeout(() => {
      if (copiedMessageId.value === message.id) copiedMessageId.value = null
    }, 1400)
  } catch (error) {
    appendMessage('system', '复制失败，请检查浏览器剪贴板权限后重试。')
    console.error(error)
  }
}

const regenerateAssistantMessage = async (message: AiAssistantMessage) => {
  const workspaceId = getActiveWorkspaceId()
  if (!workspaceId || isAsking.value || message.role !== 'assistant') return
  if (!hasIndex.value) {
    ensureBuildIndexPrompt()
    return
  }

  const conversationMessages = messages.value
  const assistantIndex = conversationMessages.findIndex((item) => item.id === message.id)
  if (assistantIndex < 0) return

  let userIndex = -1
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = conversationMessages[index]
    if (candidate.role === 'user' && candidate.text.trim()) {
      userIndex = index
      break
    }
  }

  if (userIndex < 0) {
    appendMessage('system', '找不到这条回复对应的上一条用户问题，无法重新生成。')
    return
  }

  const userMessage = conversationMessages[userIndex]
  const text = userMessage.text.trim()
  const assistantName = aiDisplayName.value
  const { history, stats } = buildConversationHistoryForRequest(text, {
    sourceMessages: conversationMessages.slice(0, userIndex),
  })

  isAsking.value = true
  workspaceStore.updateAiAssistantMessageMeta(message.id, { aiName: assistantName })
  await startAssistantRequest(workspaceId, text, message.id, history, stats)
}

const handleComposerKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return

  event.preventDefault()
  if (canAsk.value) {
    askQuestion().catch(console.error)
  }
}

const runAction = (action: AiAssistantMessageAction) => {
  if (action.type === BUILD_INDEX_ACTION_TYPE) {
    indexWorkspace().catch(console.error)
  }
}

const isActionDisabled = (action: AiAssistantMessageAction) =>
  Boolean(action.disabled || hasIndex.value || isCheckingIndex.value || !hasWorkspace.value)

const backfillLegacyAiNames = () => {
  if (!settingsStore.isLoaded) return
  workspaceStore.backfillAiAssistantMessageNames(aiDisplayName.value)
}

const createConversation = () => {
  cancelActiveStream()
  cancelActiveIndexStream()
  isAsking.value = false
  workspaceStore.createAiAssistantConversation()
  historyOpen.value = false
  scrollToBottom()
}

const selectConversation = (id: string) => {
  if (id === activeConversationId.value) {
    historyOpen.value = false
    return
  }
  cancelActiveStream()
  cancelActiveIndexStream()
  isAsking.value = false
  workspaceStore.setActiveAiAssistantConversation(id)
  historyOpen.value = false
  scrollToBottom()
}

const deleteConversation = (id: string) => {
  const conversation = conversations.value.find((item) => item.id === id)
  const ok = window.confirm(`删除对话「${conversation?.title || '新对话'}」？此操作不可恢复。`)
  if (!ok) return
  if (id === activeConversationId.value) {
    cancelActiveStream()
    isAsking.value = false
  }
  workspaceStore.deleteAiAssistantConversation(id)
  scrollToBottom()
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
  unsubscribeStreamEvents = window.electronAPI.rag.askStream.onEvent(handleStreamEvent)
  unsubscribeIndexStreamEvents = window.electronAPI.rag.indexStream.onEvent(handleIndexStreamEvent)
  workspaceStore.removeAiAssistantMessagesByText(['Not Found'])
  backfillLegacyAiNames()
  scrollToBottom()
  checkIndexStatus().catch(console.error)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
  cancelActiveStream()
  cancelActiveIndexStream()
  unsubscribeStreamEvents?.()
  unsubscribeStreamEvents = null
  unsubscribeIndexStreamEvents?.()
  unsubscribeIndexStreamEvents = null
})

watch(() => messages.value.length, scrollToBottom)
watch(() => workspaceStore.activeWorkspaceId, () => {
  cancelActiveStream()
  cancelActiveIndexStream()
  isAsking.value = false
  isIndexing.value = false
  historyOpen.value = false
  closeAiContextMenu()
  backfillLegacyAiNames()
  checkIndexStatus().catch(console.error)
})
watch(activeConversationId, () => {
  closeAiContextMenu()
  backfillLegacyAiNames()
  if (!hasIndex.value && !isCheckingIndex.value) {
    ensureBuildIndexPrompt()
  }
  scrollToBottom()
})
watch(() => settingsStore.isLoaded, backfillLegacyAiNames)
</script>

<template>
  <div class="h-full min-h-0 flex flex-col bg-panel text-text-main">
    <header class="shrink-0 border-b border-border-soft bg-panel px-4 py-4">
      <div class="flex items-center gap-3">
        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent shadow-sm">
          <Sparkles :size="18" />
        </div>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-[15px] font-semibold leading-5 tracking-normal text-text-main">
            {{ aiDisplayName }}
          </h1>
          <p class="mt-0.5 truncate text-[11px] leading-4 text-text-muted">
            {{ activeConversation.title }}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main"
            type="button"
            title="AI 设置"
            @click="workspaceStore.openSettingsPage('ai')"
          >
            <Settings :size="16" />
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main disabled:cursor-not-allowed disabled:text-text-subtle"
            type="button"
            title="历史对话"
            :disabled="!hasWorkspace"
            @click="historyOpen = !historyOpen"
          >
            <History :size="16" />
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main disabled:cursor-not-allowed disabled:text-text-subtle"
            type="button"
            title="新建对话"
            :disabled="!hasWorkspace"
            @click="createConversation"
          >
            <Plus :size="16" />
          </button>
        </div>
      </div>
    </header>

    <div
      v-if="historyOpen"
      class="shrink-0 border-b border-border-soft bg-panel px-3 py-3"
    >
      <div class="max-h-64 overflow-y-auto pr-1">
        <div class="flex flex-col gap-1.5">
          <div
            v-for="conversation in conversations"
            :key="conversation.id"
            class="group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors"
            :class="conversation.id === activeConversationId
              ? 'bg-accent-soft text-text-main'
              : 'text-text-muted hover:bg-panel-soft hover:text-text-main'"
            role="button"
            tabindex="0"
            @click="selectConversation(conversation.id)"
            @keydown.enter.prevent="selectConversation(conversation.id)"
            @keydown.space.prevent="selectConversation(conversation.id)"
          >
            <MessageSquare :size="14" class="shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-xs font-medium">
                {{ conversation.title }}
              </div>
              <div class="mt-0.5 text-[10px] leading-4 text-text-subtle">
                {{ formatConversationTime(conversation.updatedAt) }}
              </div>
            </div>
            <button
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-subtle opacity-100 transition-colors hover:bg-panel hover:text-danger sm:opacity-0 sm:group-hover:opacity-100"
              type="button"
              title="删除对话"
              @click.stop="deleteConversation(conversation.id)"
            >
              <Trash2 :size="13" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <div
      ref="messagesRef"
      class="min-h-0 flex-1 overflow-y-auto bg-panel-soft px-4 py-4"
      @contextmenu="openMessagesContextMenu"
      @scroll="closeAiContextMenu"
    >
      <div class="flex flex-col gap-4 text-sm">
        <div
          v-for="message in messages"
          :key="message.id"
          :class="[
            'flex',
            message.role === 'user'
              ? 'justify-end'
              : 'justify-center',
          ]"
        >
          <div
            :class="[
              message.role === 'user'
                ? 'max-w-[82%]'
                : 'w-full max-w-[90%]',
            ]"
          >
            <div
              v-if="message.role === 'system'"
              class="mb-2 flex items-center gap-2 px-1 text-center text-[10px] leading-4 text-text-subtle before:h-px before:flex-1 before:bg-border-soft after:h-px after:flex-1 after:bg-border-soft"
            >
              <span class="shrink-0">系统事件 · 本地 RAG</span>
            </div>

            <div
              v-else
              :class="[
                'mb-1.5 flex items-center gap-1.5 px-1 text-[10px] leading-4 text-text-subtle',
                message.role === 'user' ? 'justify-end' : 'justify-center',
              ]"
            >
              <template v-if="message.role === 'user'">
              </template>
              <template v-else>
                <Bot :size="12" />
                <span>{{ getMessageAiName(message) }}</span>
              </template>
            </div>

            <div
              v-if="message.role === 'assistant' && message.timeline?.length"
              class="mx-auto mb-3 max-w-[760px] select-text text-[12px] text-text-muted"
            >
              <div class="relative flex flex-col gap-1.5 before:absolute before:left-[3px] before:top-2 before:bottom-2 before:w-px before:bg-border-soft">
                <details
                  v-for="step in message.timeline"
                  :key="`${message.id}:timeline:${step.id}`"
                  class="group relative pl-4"
                  :open="step.status === 'active' || step.outputs.length > 0"
                >
                  <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-1.5 py-1 text-[12px] leading-5 transition-colors hover:text-text-main [&::-webkit-details-marker]:hidden">
                    <span
                      class="absolute left-0 top-2.5 h-1.5 w-1.5 rounded-full ring-4 ring-panel-soft"
                      :class="getTimelineStatusClass(step.status)"
                    />
                    <span class="min-w-0 flex-1 truncate font-medium text-text-muted">
                      {{ step.title }}
                    </span>
                    <span class="shrink-0 text-[10px] text-text-subtle">
                      {{ getTimelineStatusLabel(step.status) }} · {{ getAiTimelineStepDuration(step) }}
                    </span>
                  </summary>
                  <div
                    v-if="step.detail || step.outputs.length"
                    class="mb-2 ml-1 px-2.5 py-1.5 text-[11px] leading-5 text-text-muted"
                  >
                    <div v-if="step.detail">
                      {{ step.detail }}
                    </div>
                    <div
                      v-for="output in step.outputs"
                      :key="`${step.id}:${output.id}`"
                      class="mt-2 first:mt-0"
                    >
                      <button
                        v-if="output.type === 'source'"
                        type="button"
                        class="group w-full rounded-xl border border-border-soft bg-panel/70 px-3 py-2.5 text-left cursor-pointer transition-colors hover:border-accent/30 hover:bg-panel"
                        :disabled="!getTimelineSourcePath(output)"
                        @click="openTimelineSource(output)"
                      >
                        <div class="mb-1.5 flex items-center justify-between gap-3">
                          <span class="flex min-w-0 items-center gap-2">
                            <FileText :size="13" class="shrink-0 text-accent" />
                            <span class="truncate text-[12px] font-medium text-text-main">
                              {{ getTimelineSourceName(output) }}
                            </span>
                          </span>
                          <span v-if="getTimelineSourceScore(output)" class="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] text-accent">
                            {{ getTimelineSourceScore(output) }}
                          </span>
                        </div>
                        <div v-if="getTimelineSourcePath(output)" class="mb-1 truncate text-[10px] text-text-subtle">
                          {{ getTimelineSourcePath(output) }}
                        </div>
                        <p class="line-clamp-3 text-[11px] leading-5 text-text-muted">
                          {{ output.content || getTimelineOutputText(output) }}
                        </p>
                      </button>
                      <template v-else>
                        <span v-if="output.title" class="font-medium text-text-main">{{ output.title }}：</span>
                        <span>{{ getTimelineOutputText(output) }}</span>
                      </template>
                    </div>
                  </div>
                </details>
              </div>
            </div>

            <div
              :class="[
                'break-words text-sm leading-6 select-text',
                message.role === 'assistant' ? 'mx-auto max-w-[760px] px-1 py-1 text-text-main' : '',
                message.role === 'assistant' ? '' : 'whitespace-pre-wrap',
                message.role === 'user'
                  ? 'rounded-2xl rounded-tr-md bg-accent px-3.5 py-3 text-white shadow-sm'
                  : message.role === 'system'
                    ? 'mx-auto max-w-[760px] px-1 py-2 text-center text-text-muted'
                    : '',
              ]"
            >
              <AiMarkdown
                v-if="message.role === 'assistant'"
                :content="message.text"
              />
              <template v-else-if="message.role === 'system' && message.actions?.some((action) => action.type === BUILD_INDEX_ACTION_TYPE)">
                <div class="mb-1.5 font-semibold text-text-main">
                  当前工作空间还没有索引
                </div>
                <div>
                  {{ message.text }}
                </div>
              </template>
              <template v-else>
                {{ message.text }}
              </template>

              <div
                v-if="message.role === 'assistant' && message.id === activeAssistantMessageId"
                class="mt-2 inline-flex items-center gap-1.5 text-[11px] text-text-muted"
              >
                <Loader2 :size="12" class="animate-spin" />
                正在生成
              </div>

              <div
                v-if="message.role === 'assistant' && message.id !== activeAssistantMessageId && !(message.actions && message.actions.length)"
                class="mt-4 flex flex-wrap items-center justify-center gap-2 pt-1"
              >
                <button
                  class="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-text-muted"
                  type="button"
                  :disabled="!message.text.trim()"
                  @click="copyAssistantMessage(message)"
                >
                  <Copy :size="12" />
                  {{ copiedMessageId === message.id ? '已复制' : '复制' }}
                </button>
                <button
                  class="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-text-muted"
                  type="button"
                  :disabled="isAsking || isIndexing || isCheckingIndex || !hasWorkspace || !hasIndex"
                  @click="regenerateAssistantMessage(message)"
                >
                  <RotateCcw :size="12" />
                  重新生成
                </button>
              </div>
            </div>

            <div
              v-for="action in message.actions || []"
              :key="`${message.id}:${action.type}`"
              class="mx-auto mt-3 max-w-[760px] px-1 py-2 text-text-main"
              :class="message.role === 'system' ? 'text-center' : 'w-full'"
            >
              <div class="mb-3 flex items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-2">
                  <Loader2
                    v-if="isIndexing && action.type === BUILD_INDEX_ACTION_TYPE"
                    :size="14"
                    class="shrink-0 animate-spin text-text-muted"
                  />
                  <Sparkles v-else :size="14" class="shrink-0 text-accent" />
                  <span class="truncate text-xs font-medium text-text-main">
                    {{ action.title }}
                  </span>
                </div>
                <span v-if="message.role !== 'system'" class="shrink-0 text-[10px] text-text-subtle">本地 RAG</span>
              </div>
              <div class="text-xs leading-5 text-text-muted">
                {{ action.description }}
              </div>
              <button
                class="mt-3 inline-flex h-9 w-full items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors"
                :class="!isActionDisabled(action) && !(isIndexing && action.type === BUILD_INDEX_ACTION_TYPE)
                  ? 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
                  : 'bg-panel-soft text-text-subtle cursor-not-allowed'"
                type="button"
                :disabled="isActionDisabled(action) || (isIndexing && action.type === BUILD_INDEX_ACTION_TYPE)"
                @click="runAction(action)"
              >
                {{ isIndexing && action.type === BUILD_INDEX_ACTION_TYPE ? '正在建立索引...' : action.buttonText }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <footer class="shrink-0 border-t border-border-soft bg-panel px-3 py-3">
      <form
        class="rounded-2xl border border-border-soft bg-panel-soft p-2.5 shadow-sm"
        @submit.prevent="askQuestion"
      >
        <textarea
          ref="composerRef"
          v-model="question"
          class="h-[58px] w-full resize-none bg-transparent text-sm leading-6 text-text-main outline-none placeholder:text-text-subtle disabled:text-text-muted select-text"
          :placeholder="inputPlaceholder"
          :disabled="!hasWorkspace || !hasIndex || isCheckingIndex || isIndexing || isAsking"
          @keydown="handleComposerKeydown"
          @contextmenu="openComposerContextMenu"
        />
        <div class="flex items-center justify-between gap-2 pt-2">
          <div class="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <button
              class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border-soft bg-panel px-2.5 text-[11px] text-text-muted disabled:cursor-default disabled:opacity-80"
              type="button"
              disabled
            >
              <Paperclip :size="12" />
              附件
            </button>
            <button
              class="inline-flex h-7 shrink-0 items-center rounded-lg border border-border-soft bg-panel px-2.5 text-[11px] text-text-muted disabled:cursor-default disabled:opacity-80"
              type="button"
              disabled
            >
              @当前笔记
            </button>
            <button
              class="inline-flex h-7 shrink-0 items-center rounded-lg border border-border-soft bg-panel px-2.5 text-[11px] text-text-muted disabled:cursor-default disabled:opacity-80"
              type="button"
              disabled
            >
              /指令
            </button>
          </div>

          <button
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors"
            :class="canAsk
              ? 'bg-accent text-white hover:bg-accent-hover cursor-pointer shadow-sm'
              : 'bg-accent-soft text-text-muted cursor-not-allowed'"
            type="submit"
            :disabled="!canAsk"
            :aria-label="isAsking ? '发送中' : '发送'"
          >
            <Loader2 v-if="isAsking" :size="14" class="animate-spin" />
            <Send v-else :size="14" />
          </button>
        </div>
      </form>
    </footer>

    <div
      v-if="aiContextMenu.visible"
      ref="contextMenuRef"
      class="fixed z-50 w-40 select-none rounded-lg border border-border-soft bg-panel py-1 text-sm text-text-main shadow-xl"
      :style="{ top: `${aiContextMenu.top}px`, left: `${aiContextMenu.left}px` }"
      @click.stop
    >
      <button
        v-if="aiContextMenu.selectedText"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent-soft"
        @click="copySelectedContextText"
      >
        <Copy :size="14" class="text-text-muted" />
        <span>复制</span>
      </button>
      <button
        v-if="aiContextMenu.source === 'composer'"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent-soft"
        @click="pasteIntoComposer"
      >
        <Clipboard :size="14" class="text-text-muted" />
        <span>粘贴</span>
      </button>
      <button
        v-if="aiContextMenu.source === 'messages' && aiContextMenu.selectedText"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent-soft"
        @click="addSelectionToComposer"
      >
        <MessageSquare :size="14" class="text-text-muted" />
        <span>加入对话框</span>
      </button>
      <button
        v-if="aiContextMenu.source === 'messages' && aiContextMenu.selectedText"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent-soft"
        @click="explainSelection"
      >
        <Sparkles :size="14" class="text-text-muted" />
        <span>AI解释</span>
      </button>
    </div>
  </div>
</template>
