import type { AiAssistantConversation, AiAssistantMessage } from './workspace-types'

export type AiAssistantHistoryGroup = '近 7 日' | '近 30 日' | '近 90 日' | '更早'

const DAY_MS = 24 * 60 * 60 * 1000

export const getAiAssistantConversationTitle = (messages: AiAssistantMessage[]) => {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.text.trim())
  const title = firstUserMessage?.text.trim().replace(/\s+/g, ' ') || '新对话'
  return title.length > 24 ? `${title.slice(0, 24)}...` : title
}

export const sortAiAssistantConversations = (conversations: AiAssistantConversation[]) => (
  [...conversations].sort((a, b) => {
    const aPinned = Boolean(a.pinned)
    const bPinned = Boolean(b.pinned)
    if (aPinned !== bPinned) return aPinned ? -1 : 1
    if (aPinned && bPinned) return (b.pinnedAt || b.updatedAt) - (a.pinnedAt || a.updatedAt)
    return b.updatedAt - a.updatedAt
  })
)

export const getAiAssistantHistoryGroup = (timestamp: number, now = Date.now()): AiAssistantHistoryGroup => {
  if (!Number.isFinite(timestamp)) return '更早'
  const ageDays = Math.floor(Math.max(0, now - timestamp) / DAY_MS)
  if (ageDays <= 7) return '近 7 日'
  if (ageDays <= 30) return '近 30 日'
  if (ageDays <= 90) return '近 90 日'
  return '更早'
}

export const hasUserAiAssistantMessage = (conversation: AiAssistantConversation) =>
  conversation.messages.some((message) => message.role === 'user' && message.text.trim())
