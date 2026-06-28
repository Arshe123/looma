import { describe, expect, it } from 'vitest'
import type { AiAssistantConversation } from '../workspace-types'
import {
  getAiAssistantConversationTitle,
  sortAiAssistantConversations,
  getAiAssistantHistoryGroup,
} from '../workspace-ai-utils'

const makeConversation = (overrides: Partial<AiAssistantConversation>): AiAssistantConversation => ({
  id: overrides.id || `chat-${Math.random()}`,
  title: overrides.title || '测试对话',
  createdAt: overrides.createdAt ?? Date.now(),
  updatedAt: overrides.updatedAt ?? Date.now(),
  messages: overrides.messages || [],
  draft: overrides.draft || '',
  archived: overrides.archived,
  archivedAt: overrides.archivedAt,
  pinned: overrides.pinned,
  pinnedAt: overrides.pinnedAt,
  favorite: overrides.favorite,
  favoriteCategory: overrides.favoriteCategory,
  titleEdited: overrides.titleEdited,
})

describe('workspace ai assistant utilities', () => {
  it('derives a title from the first non-empty user message', () => {
    expect(getAiAssistantConversationTitle([
      { id: 1, role: 'assistant', text: 'hello', createdAt: 1 },
      { id: 2, role: 'user', text: '  如何建立本地知识库索引并查看结果？请给出完整步骤和注意事项  ', createdAt: 2 },
    ])).toBe('如何建立本地知识库索引并查看结果？请给出完整步骤...')
  })

  it('sorts pinned conversations before ordinary conversations', () => {
    const conversations = [
      makeConversation({ id: 'normal-new', updatedAt: 3000 }),
      makeConversation({ id: 'pinned-old', updatedAt: 1000, pinned: true, pinnedAt: 4000 }),
      makeConversation({ id: 'normal-old', updatedAt: 2000 }),
    ]

    expect(sortAiAssistantConversations(conversations).map((item) => item.id)).toEqual([
      'pinned-old',
      'normal-new',
      'normal-old',
    ])
  })

  it('groups conversations into requested history timeline buckets', () => {
    const now = new Date('2026-06-24T00:00:00Z').getTime()
    const day = 24 * 60 * 60 * 1000

    expect(getAiAssistantHistoryGroup(now - 2 * day, now)).toBe('近 7 日')
    expect(getAiAssistantHistoryGroup(now - 20 * day, now)).toBe('近 30 日')
    expect(getAiAssistantHistoryGroup(now - 60 * day, now)).toBe('近 90 日')
    expect(getAiAssistantHistoryGroup(now - 120 * day, now)).toBe('更早')
  })
})
