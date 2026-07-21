import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'
import { useAiAssistantStore } from '../ai-assistant'

const installElectronApiStub = () => {
  ;(globalThis as any).window = globalThis.window || globalThis
  ;(globalThis as any).window.electronAPI = {
    workspaceAi: {
      get: vi.fn(),
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
    agent: {
      runStream: {
        start: vi.fn().mockResolvedValue({ success: true }),
        cancel: vi.fn().mockResolvedValue({ success: true }),
        onEvent: vi.fn(() => vi.fn()),
      },
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

  it('updates the original Agent conversation when an event arrives after switching conversations', () => {
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

    aiAssistStore.agentRunsByConversationId[conversationAId] = {
      requestId: 'req-a',
      runId: 'run-a',
      workspaceId: 'workspace-1',
      conversationId: conversationAId,
      assistantMessageId: assistantMessageId!,
      assistantText: '',
      status: 'streaming',
      startedAt: Date.now(),
      approvalResolutionInFlight: {},
    }
    aiAssistStore.agentRequestIdToConversationId['req-a'] = conversationAId

    workspaceStore.startTemporaryAiAssistantConversation()
    const conversationBId = workspaceStore.ensureAiAssistantConversationForRequest()

    aiAssistStore.handleAgentStreamEvent({
      requestId: 'req-a',
      type: 'delta',
      runId: 'run-a',
      text: 'A 会话回答',
      content: 'A 会话回答',
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

  it('normalizes and saves persisted agent message identity and compact summary without backfilling legacy messages', async () => {
    const store = useWorkspaceStore()
    const persistedState = {
      conversations: [{
        id: 'agent-chat',
        title: 'Agent 对话',
        createdAt: 10,
        updatedAt: 20,
        draft: '',
        messages: [
          { id: 1, role: 'assistant', text: '旧回答', createdAt: 1 },
          {
            id: 2,
            role: 'assistant',
            text: 'Agent 回答',
            createdAt: 20,
            runId: 'run-persisted',
            mode: 'agent',
            modelIdentity: { provider: 'openai', model: 'gpt-4o-mini', displayName: 'GPT 4o Mini' },
            agentSummary: { status: 'completed', toolCallCount: 2, sourceCount: 1 },
            timeline: [{
              id: 'sources', title: '来源', status: 'completed', startedAt: 20,
              outputs: [
                { id: 'safe', type: 'source', path: 'docs/guide.md', metadata: { source: 'docs/guide.md', score: 0.9, secret: 'drop-me' } },
                { id: 'absolute', type: 'source', path: 'C:\\Users\\admin\\secret.md', metadata: { source: 'C:\\Users\\admin\\secret.md', score: 0.1 } },
                { id: 'traversal', type: 'source', path: '../secret.md', metadata: { file_path: '../secret.md', path: '../secret.md' } },
                { id: 'internal', type: 'source', path: '.LOOMA/ai/state.json', metadata: { source: '.LOOMA/ai/state.json' } },
              ],
            }],
          },
        ],
      }],
      activeConversationId: 'agent-chat',
    }
    ;(window.electronAPI.workspaceAi.get as any).mockResolvedValue({ success: true, data: persistedState })

    await store.loadAiAssistantState('workspace-1')
    const [legacyMessage, agentMessage] = store.aiAssistant.conversations[0].messages

    expect(legacyMessage).not.toHaveProperty('modelIdentity')
    expect(agentMessage).toMatchObject({
      runId: 'run-persisted',
      mode: 'agent',
      modelIdentity: { provider: 'openai', model: 'gpt-4o-mini', displayName: 'GPT 4o Mini' },
      agentSummary: { status: 'completed', toolCallCount: 2, sourceCount: 1 },
    })
    expect(agentMessage.timeline?.[0].outputs.map(output => output.path)).toEqual(['docs/guide.md', undefined, undefined, undefined])
    expect(agentMessage.timeline?.[0].outputs.map(output => output.metadata)).toEqual([
      { source: 'docs/guide.md', score: 0.9 },
      { score: 0.1 },
      undefined,
      undefined,
    ])

    store.activeWorkspaceId = 'workspace-1'
    store.saveAiAssistantState()
    expect(window.electronAPI.workspaceAi.set).toHaveBeenLastCalledWith(
      'workspace-1',
      expect.objectContaining({
        conversations: [expect.objectContaining({
          messages: expect.arrayContaining([expect.objectContaining({
            runId: 'run-persisted',
            mode: 'agent',
            modelIdentity: { provider: 'openai', model: 'gpt-4o-mini', displayName: 'GPT 4o Mini' },
            agentSummary: { status: 'completed', toolCallCount: 2, sourceCount: 1 },
          })]),
        })],
      }),
    )
  })

  it('does not invent interruption facts when a legacy running message has not been hydrated from the ledger', async () => {
    const store = useWorkspaceStore()
    ;(window.electronAPI.workspaceAi.get as any).mockResolvedValue({
      success: true,
      data: {
        conversations: [{
          id: 'interrupted', title: 'Interrupted', createdAt: 1, updatedAt: 2, draft: '',
          messages: [{
            id: 1, role: 'assistant', text: '', createdAt: 1, mode: 'agent',
            agentSummary: { status: 'running', toolCallCount: 1 },
            timeline: [{ id: 'active', title: '读取文件', status: 'active', startedAt: 1, outputs: [] }],
          }],
        }],
        activeConversationId: 'interrupted',
      },
    })

    await store.loadAiAssistantState('workspace-1')

    const message = store.aiAssistant.conversations[0].messages[0]
    expect(message.agentSummary).toMatchObject({ status: 'running', toolCallCount: 1 })
    expect(message.text).toBe('')
    expect(message.timeline?.[0]).toMatchObject({ status: 'active' })
    expect(message.timeline?.[0].endedAt).toBeUndefined()
  })

})
