import type {
  AiAssistantAgentSummary,
  AiAssistantMessage,
  AiAssistantModelIdentity,
  AiAssistantTimelineStep,
} from '@/renderer/stores/workspace-types'

export type AgentUiStatus = AiAssistantAgentSummary['status'] | 'idle'

export interface AgentUiState {
  message?: AiAssistantMessage
  messageId?: number
  timeline: AiAssistantTimelineStep[]
  sourceCount: number
  toolCallCount: number
  status: AgentUiStatus
  statusLabel: string
  errorMessage?: string
  technicalDetail?: string
  modelIdentity?: AiAssistantModelIdentity
}

const statusLabels: Record<AgentUiStatus, string> = {
  idle: '未运行',
  running: '运行中',
  completed: '已完成',
  cancelled: '已取消',
  error: '运行失败',
}

const hasProcess = (message: AiAssistantMessage) => (
  message.role === 'assistant'
  && (Boolean(message.timeline?.length) || Boolean(message.agentSummary))
)

const findProcessMessage = (messages: AiAssistantMessage[], selectedMessageId?: number) => {
  const selected = selectedMessageId === undefined
    ? undefined
    : messages.find((message) => message.id === selectedMessageId)
  if (selected && hasProcess(selected)) return selected

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (hasProcess(messages[index])) return messages[index]
  }
  return undefined
}

const inferStatus = (message?: AiAssistantMessage): AgentUiStatus => {
  if (message?.agentSummary?.status) return message.agentSummary.status
  if (message?.timeline?.some((step) => step.status === 'error')) return 'error'
  if (message?.timeline?.some((step) => step.status === 'active')) return 'running'
  if (message?.timeline?.length && message.timeline.every((step) => step.status === 'completed')) return 'completed'
  return 'idle'
}

const countSources = (message?: AiAssistantMessage) => {
  const persistedCount = message?.agentSummary?.sourceCount
  if (typeof persistedCount === 'number' && Number.isFinite(persistedCount)) {
    return Math.max(0, Math.round(persistedCount))
  }
  return message?.timeline?.reduce(
    (total, step) => total + step.outputs.filter((output) => output.type === 'source').length,
    0,
  ) ?? 0
}

const countToolCalls = (message?: AiAssistantMessage) => {
  const persistedCount = message?.agentSummary?.toolCallCount
  if (typeof persistedCount === 'number' && Number.isFinite(persistedCount)) {
    return Math.max(0, Math.round(persistedCount))
  }
  return message?.timeline?.filter((step) => step.title.startsWith('调用 ')).length ?? 0
}

/**
 * Builds drawer/bubble state strictly from the selected (or latest) persisted
 * assistant message. `currentModelIdentity` is intentionally ignored: legacy
 * messages must never be stamped with whatever model happens to be configured now.
 */
export const deriveAgentUiState = (
  messages: AiAssistantMessage[],
  selectedMessageId?: number,
  _currentModelIdentity?: AiAssistantModelIdentity,
): AgentUiState => {
  const message = findProcessMessage(messages, selectedMessageId)
  const status = inferStatus(message)
  return {
    message,
    messageId: message?.id,
    timeline: message?.timeline ?? [],
    sourceCount: countSources(message),
    toolCallCount: countToolCalls(message),
    status,
    statusLabel: statusLabels[status],
    errorMessage: message?.agentSummary?.error?.message,
    technicalDetail: message?.agentSummary?.error?.technicalDetail,
    modelIdentity: message?.modelIdentity,
  }
}
