import type { AiAssistantMessage, AiAssistantTimelineStep } from './workspace-types'

export type AgentHistoryToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

export type AgentHistoryMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  name?: string
  tool_calls?: AgentHistoryToolCall[]
  tool_call_id?: string
}

const AGENT_TOOL_NAMES = new Set([
  'rag_search',
  'workspace_list',
  'workspace_search',
  'file_read',
  'file_patch',
])

const parseArguments = (step: AiAssistantTimelineStep): Record<string, unknown> => {
  const raw = step.outputs.find(output => output.title === '调用参数')?.content
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

const getToolName = (step: AiAssistantTimelineStep) => {
  const match = step.title.trim().match(/^调用\s+([a-z_]+)$/i)
  const tool = match?.[1] || ''
  return AGENT_TOOL_NAMES.has(tool) ? tool : ''
}

const getResultContent = (step: AiAssistantTimelineStep) => {
  const result = step.outputs.find(output => output.title === '结果摘要' || output.title === '错误')
  return result?.content?.trim() || ''
}

const historyToolMessages = (message: AiAssistantMessage): AgentHistoryMessage[] => {
  if (message.role !== 'assistant' || message.mode !== 'agent' || !message.timeline?.length) return []

  const messages: AgentHistoryMessage[] = []
  message.timeline.forEach((step, stepIndex) => {
    const tool = getToolName(step)
    const result = getResultContent(step)
    // Provider-native tool history must contain a complete call/result pair.
    // Interrupted or legacy incomplete rows remain visible in the UI but are not sent to the model.
    if (!tool || !result) return
    const callId = `history_${message.id}_${stepIndex + 1}`
    messages.push(
      {
        role: 'assistant',
        content: `此前调用了工具 ${tool}。`,
        tool_calls: [{
          id: callId,
          type: 'function',
          function: { name: tool, arguments: parseArguments(step) },
        }],
      },
      {
        role: 'tool',
        name: tool,
        tool_call_id: callId,
        content: result,
      },
    )
  })
  return messages
}

export const normalizeAgentConversationHistory = (
  sourceMessages: AiAssistantMessage[],
  excluded: Set<number>,
): AgentHistoryMessage[] => sourceMessages.flatMap((message) => {
  if (
    (message.role !== 'user' && message.role !== 'assistant')
    || excluded.has(message.id)
    || message.actions?.length
    || message.createdAt === 1
    || !message.text.trim()
  ) return []

  const history: AgentHistoryMessage[] = []
  if (message.role === 'assistant') history.push(...historyToolMessages(message))
  history.push({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.text.trim(),
  })
  return history
})

export const flattenAgentHistoryForSummary = (messages: AgentHistoryMessage[]): AgentHistoryMessage[] => messages.map((message) => {
  if (message.role === 'tool') {
    return {
      role: 'assistant',
      content: `工具 ${message.name || 'unknown'} 返回：${message.content}`,
    }
  }
  if (message.tool_calls?.length) {
    const calls = message.tool_calls.map(call => (
      `${call.function.name}(${JSON.stringify(call.function.arguments)})`
    )).join('；')
    return { role: 'assistant', content: `${message.content}\n工具调用：${calls}` }
  }
  return { role: message.role, content: message.content }
})
