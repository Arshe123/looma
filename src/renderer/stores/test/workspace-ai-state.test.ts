import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'
import { useAiAssistantStore } from '../ai-assistant'

const installElectronApiStub = () => {
  ;(globalThis as any).window = globalThis.window || globalThis
  ;(globalThis as any).window.electronAPI = {
    workspaceAi: {
      set: vi.fn().mockResolvedValue({ success: true }),
    },
    rag: {
      askStream: {
        start: vi.fn().mockResolvedValue({ success: true }),
        cancel: vi.fn().mockResolvedValue({ success: true }),
        onEvent: vi.fn(() => vi.fn()),
      },
      indexStream: {
        start: vi.fn().mockResolvedValue({ success: true }),
        cancel: vi.fn().mockResolvedValue({ success: true }),
        onEvent: vi.fn(() => vi.fn()),
      },
      summarizeConversation: vi.fn().mockResolvedValue({ success: true, data: { answer: '摘要' } }),
    },
  }
}

describe('workspace ai assistant temporary conversation state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installElectronApiStub()
  })

  it('does not create persisted conversations when starting temporary chats repeatedly', () => {
    const store = useWorkspaceStore()
    const originalCount = store.aiAssistant.conversations.length

    store.startTemporaryAiAssistantConversation()
    store.startTemporaryAiAssistantConversation()
    store.startTemporaryAiAssistantConversation()

    expect(store.aiAssistant.isTemporaryConversation).toBe(true)
    expect(store.aiAssistant.activeConversationId).toBeNull()
    expect(store.aiAssistant.conversations).toHaveLength(originalCount)
  })

  it('stores drafts in temporary state without touching existing conversation drafts', () => {
    const store = useWorkspaceStore()
    const existingId = store.aiAssistant.conversations[0].id

    store.startTemporaryAiAssistantConversation()
    store.setAiAssistantDraft('临时问题')

    expect(store.aiAssistant.temporaryDraft).toBe('临时问题')
    expect(store.aiAssistant.activeConversationId).toBeNull()
    expect(store.aiAssistant.conversations[0].id).toBe(existingId)
    expect(store.aiAssistant.conversations[0].draft).toBe('')
  })

  it('materializes a real conversation only when the first message is appended', () => {
    const store = useWorkspaceStore()
    const originalCount = store.aiAssistant.conversations.length

    store.startTemporaryAiAssistantConversation()
    store.setAiAssistantDraft('第一条问题')
    const messageId = store.appendAiAssistantMessage('user', '第一条问题')

    expect(messageId).toBeTypeOf('number')
    expect(store.aiAssistant.isTemporaryConversation).toBe(false)
    expect(store.aiAssistant.activeConversationId).toBe(store.aiAssistant.conversations[0].id)
    expect(store.aiAssistant.conversations).toHaveLength(originalCount + 1)
    expect(store.aiAssistant.conversations[0].title).toBe('第一条问题')
    expect(store.aiAssistant.conversations[0].messages[0]).toMatchObject({ role: 'user', text: '第一条问题' })
  })

  it('updates the original conversation when a stream event arrives after switching conversations', () => {
    const workspaceStore = useWorkspaceStore()
    const aiAssistStore = useAiAssistantStore()

    workspaceStore.startTemporaryAiAssistantConversation()
    const conversationAId = workspaceStore.ensureAiAssistantConversationForRequest()
    const assistantMessageId = workspaceStore.appendAiAssistantMessageToConversation(
      conversationAId,
      'assistant',
      '',
    )
    expect(assistantMessageId).toBeTypeOf('number')

    aiAssistStore.streamsByConversationId[conversationAId] = {
      requestId: 'req-a',
      workspaceId: 'workspace-1',
      conversationId: conversationAId,
      assistantMessageId: assistantMessageId!,
      assistantText: '',
      timeline: [],
      status: 'streaming',
      startedAt: Date.now(),
    }
    aiAssistStore.requestIdToConversationId['req-a'] = conversationAId

    workspaceStore.startTemporaryAiAssistantConversation()
    const conversationBId = workspaceStore.ensureAiAssistantConversationForRequest()

    aiAssistStore.handleStreamEvent({
      requestId: 'req-a',
      type: 'delta',
      text: 'A 会话回答',
    })

    const aMessage = workspaceStore
      .getAiAssistantConversationById(conversationAId)!
      .messages.find((item) => item.id === assistantMessageId)
    const bConversation = workspaceStore.getAiAssistantConversationById(conversationBId)!

    expect(aMessage?.text).toBe('A 会话回答')
    expect(bConversation.messages.some((item) => item.text.includes('A 会话回答'))).toBe(false)
  })

  it('updates the original index conversation when an index stream finishes after switching conversations', () => {
    const workspaceStore = useWorkspaceStore()
    const aiAssistStore = useAiAssistantStore()

    workspaceStore.startTemporaryAiAssistantConversation()
    const conversationAId = workspaceStore.ensureAiAssistantConversationForRequest()
    const messageId = workspaceStore.appendAiAssistantMessageToConversation(
      conversationAId,
      'assistant',
      '正在建立当前工作空间索引...',
    )
    expect(messageId).toBeTypeOf('number')

    aiAssistStore.indexStreamsByWorkspaceId['workspace-1'] = {
      requestId: 'idx-a',
      workspaceId: 'workspace-1',
      conversationId: conversationAId,
      messageId: messageId!,
      timeline: [],
      status: 'streaming',
      startedAt: Date.now(),
    }
    aiAssistStore.indexRequestIdToWorkspaceId['idx-a'] = 'workspace-1'

    workspaceStore.startTemporaryAiAssistantConversation()
    const conversationBId = workspaceStore.ensureAiAssistantConversationForRequest()

    aiAssistStore.handleIndexStreamEvent({
      requestId: 'idx-a',
      type: 'done',
      result: { exists: true, document_count: 3 },
    })

    const aMessage = workspaceStore
      .getAiAssistantConversationById(conversationAId)!
      .messages.find((item) => item.id === messageId)
    const bConversation = workspaceStore.getAiAssistantConversationById(conversationBId)!

    expect(aMessage?.text).toBe('索引已建立，共处理 3 个文档。现在可以开始提问。')
    expect(bConversation.messages.some((item) => item.text.includes('索引已建立'))).toBe(false)
    expect(aiAssistStore.getWorkspaceIndexResult('workspace-1')?.exists).toBe(true)
  })

})
