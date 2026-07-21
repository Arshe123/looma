import type { AgentMessage } from '../types/agent-message'

export interface AgentMessageInvariantIssue {
  code: 'invalid_message' | 'duplicate_call' | 'unmatched_tool_result' | 'unmatched_tool_call' | 'tool_name_mismatch'
  messageId: string
  callId?: string
}

export const validateAgentMessageTranscript = (messages: AgentMessage[]): AgentMessageInvariantIssue[] => {
  const issues: AgentMessageInvariantIssue[] = []
  const pending = new Map<string, { name: string; messageId: string }>()
  const seenCalls = new Set<string>()

  for (const message of messages) {
    const hasContent = typeof message.content === 'string' && Boolean(message.content.trim())
    if (!message.id || !message.conversationId || !Number.isFinite(message.createdAt)) {
      issues.push({ code: 'invalid_message', messageId: message.id || 'unknown' })
      continue
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        if (seenCalls.has(call.id)) {
          issues.push({ code: 'duplicate_call', messageId: message.id, callId: call.id })
          continue
        }
        seenCalls.add(call.id)
        pending.set(call.id, { name: call.function.name, messageId: message.id })
      }
      continue
    }

    if (message.role === 'tool') {
      const callId = message.tool_call_id || ''
      const declaration = pending.get(callId)
      if (!callId || !message.name || !hasContent || !declaration) {
        issues.push({ code: 'unmatched_tool_result', messageId: message.id, callId: callId || undefined })
        continue
      }
      if (declaration.name !== message.name) {
        issues.push({ code: 'tool_name_mismatch', messageId: message.id, callId })
        continue
      }
      pending.delete(callId)
      continue
    }

    if (!hasContent) issues.push({ code: 'invalid_message', messageId: message.id })
  }

  for (const [callId, declaration] of pending) {
    issues.push({ code: 'unmatched_tool_call', messageId: declaration.messageId, callId })
  }
  return issues
}

export const assertAgentMessageTranscript = (messages: AgentMessage[]) => {
  const issues = validateAgentMessageTranscript(messages)
  if (issues.length) {
    const first = issues[0]
    throw new Error(`Invalid Agent message transcript: ${first.code}${first.callId ? ` (${first.callId})` : ''}`)
  }
}
