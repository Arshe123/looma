import type { AiAssistantMessage } from './workspace-types'

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

const historyToolMessages = (canonical: AgentHistoryMessage[]): AgentHistoryMessage[] => {
  const messages: AgentHistoryMessage[] = []
  const resultsById = new Map<string, Array<{ message: AgentHistoryMessage; index: number }>>()
  canonical.forEach((message, index) => {
    if (message.role !== 'tool' || !message.tool_call_id) return
    const results = resultsById.get(message.tool_call_id) || []
    results.push({ message, index })
    resultsById.set(message.tool_call_id, results)
  })
  const usedIds = new Set<string>()
  for (let index = 0; index < canonical.length; index += 1) {
    const call = canonical[index]
    if (call.role !== 'assistant' || !call.tool_calls?.length) continue
    const ids = new Set(call.tool_calls.map(item => item.id))
    if (ids.size !== call.tool_calls.length || call.tool_calls.some(item => {
      const results = resultsById.get(item.id)
      return usedIds.has(item.id) || results?.length !== 1 || results[0].index <= index
    })) continue
    const results = call.tool_calls.map(item => {
      usedIds.add(item.id)
      return resultsById.get(item.id)![0].message
    })
    messages.push(call, ...results)
  }
  return messages
}

export const normalizeAgentConversationHistory = (
  sourceMessages: AiAssistantMessage[],
  excluded: Set<number>,
  canonicalHistory: ReadonlyMap<number, AgentHistoryMessage[]> = new Map(),
): AgentHistoryMessage[] => sourceMessages.flatMap((message) => {
  if (
    (message.role !== 'user' && message.role !== 'assistant')
    || excluded.has(message.id)
    || message.actions?.length
    || message.createdAt === 1
    || !message.text.trim()
  ) return []

  const history: AgentHistoryMessage[] = []
  // UI timeline summaries are not model observations. Without the ledger keep
  // the visible answer, but never manufacture successful tool results.
  if (message.role === 'assistant') history.push(...historyToolMessages(canonicalHistory.get(message.id) || []))
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
