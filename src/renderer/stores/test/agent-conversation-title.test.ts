import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiAssistantStore } from '../ai-assistant'
import { useWorkspaceStore } from '../workspace'

const generateTitle = vi.fn()
const persist = vi.fn()
const finish = (conversationId: string, answer = '已完成项目整理', status: 'completed' | 'cancelled' = 'completed') => {
  const workspace = useWorkspaceStore()
  const store = useAiAssistantStore()
  const assistantMessageId = workspace.appendAiAssistantMessageToConversation(conversationId, 'assistant', '', undefined, {
    mode: 'agent', agentSummary: { status: 'running' },
  })!
  store.agentRunsByConversationId[conversationId] = {
    requestId: `request-${assistantMessageId}`, workspaceId: 'ws', conversationId, assistantMessageId,
    assistantText: answer, status: 'streaming', startedAt: 1, approvalResolutionInFlight: {},
  }
  store.completeAgentConversation(conversationId, status)
}
const setupConversation = () => {
  const workspace = useWorkspaceStore()
  workspace.activeWorkspaceId = 'ws'
  workspace.startTemporaryAiAssistantConversation()
  const id = workspace.ensureAiAssistantConversationForRequest()
  workspace.appendAiAssistantMessageToConversation(id, 'user', '请帮我整理项目文档')
  return workspace.getAiAssistantConversationById(id)!
}

beforeEach(() => {
  setActivePinia(createPinia())
  generateTitle.mockReset().mockResolvedValue({ success: true, data: { title: '项目文档整理' } })
  persist.mockReset().mockResolvedValue({ success: true })
  ;(globalThis as any).window = globalThis
  ;(window as any).electronAPI = { workspaceAi: { set: persist }, agent: { generateConversationTitle: generateTitle } }
})

describe('Agent conversation titles', () => {
  it.each(['rename', 'delete', 'switch', 'reload', 'blocked'])('discards a late title after %s', async change => {
    let resolve!: (value: unknown) => void
    generateTitle.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const workspace = useWorkspaceStore()
    const conversation = setupConversation()
    finish(conversation.id)
    expect(generateTitle).toHaveBeenCalledTimes(1)
    if (change === 'rename') workspace.renameAiAssistantConversation(conversation.id, '手动标题')
    if (change === 'delete') workspace.deleteAiAssistantConversation(conversation.id)
    if (change === 'switch') workspace.activeWorkspaceId = 'other'
    if (change === 'reload') workspace.aiAssistantLoadRequestId += 1
    if (change === 'blocked') workspace.aiAssistantLoadStatus = 'loading'
    const writes = persist.mock.calls.length
    resolve({ success: true, data: { title: '不能写入的标题' } })
    await vi.waitFor(() => expect(Object.keys(useAiAssistantStore().conversationTitleRequests)).toHaveLength(0))
    expect(conversation.title).toBe(change === 'rename' ? '手动标题' : '请帮我整理项目文档')
    expect(persist).toHaveBeenCalledTimes(writes)
  })

  it('deduplicates pending requests and does not change the active conversation', async () => {
    let resolve!: (value: unknown) => void
    generateTitle.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const first = setupConversation()
    finish(first.id)
    finish(first.id, '另一轮回答')
    expect(generateTitle).toHaveBeenCalledTimes(1)
    const second = setupConversation()
    resolve({ success: true, data: { title: '原会话标题' } })
    await vi.waitFor(() => expect(first.title).toBe('原会话标题'))
    expect(second.title).toBe('请帮我整理项目文档')
    expect(useWorkspaceStore().aiAssistant.activeConversationId).toBe(second.id)
  })

  it('does not let a previous load overwrite the newer title request after returning to the workspace', async () => {
    let oldResolve!: (value: unknown) => void
    generateTitle.mockReturnValueOnce(new Promise(done => { oldResolve = done }))
    const conversation = setupConversation()
    finish(conversation.id)
    const workspace = useWorkspaceStore()
    workspace.aiAssistantLoadRequestId += 1
    workspace.aiAssistant = JSON.parse(JSON.stringify(workspace.aiAssistant))
    finish(conversation.id, '返回后的回答')
    const current = workspace.getAiAssistantConversationById(conversation.id)!
    await vi.waitFor(() => expect(current.title).toBe('项目文档整理'))
    oldResolve({ success: true, data: { title: '旧请求的标题' } })
    await vi.waitFor(() => expect(Object.keys(useAiAssistantStore().conversationTitleRequests)).toHaveLength(0))
    expect(current.title).toBe('项目文档整理')
    expect(generateTitle).toHaveBeenCalledTimes(2)
  })

  it('does not generate when an Agent run fails', async () => {
    const conversation = setupConversation()
    const store = useAiAssistantStore()
    const messageId = useWorkspaceStore().appendAiAssistantMessageToConversation(conversation.id, 'assistant', '', undefined, { mode: 'agent' })!
    store.agentRunsByConversationId[conversation.id] = {
      requestId: 'failed-request', workspaceId: 'ws', conversationId: conversation.id,
      assistantMessageId: messageId, assistantText: '部分输出', status: 'streaming', startedAt: 1, approvalResolutionInFlight: {},
    }
    store.failAgentConversation(conversation.id, '运行失败')
    await Promise.resolve()
    expect(generateTitle).not.toHaveBeenCalled()
    expect(conversation.title).toBe('请帮我整理项目文档')
  })

  it('handles a streamed done answer once even when the terminal event is duplicated', async () => {
    const conversation = setupConversation()
    const store = useAiAssistantStore()
    ;(window.electronAPI.agent as any).listApprovals = vi.fn().mockResolvedValue({ success: true, data: [] })
    const messageId = useWorkspaceStore().appendAiAssistantMessageToConversation(conversation.id, 'assistant', '', undefined, { mode: 'agent' })!
    store.agentRunsByConversationId[conversation.id] = {
      requestId: 'stream-request', workspaceId: 'ws', conversationId: conversation.id,
      assistantMessageId: messageId, assistantText: '', status: 'streaming', startedAt: 1, approvalResolutionInFlight: {},
    }
    store.agentRequestIdToConversationId['stream-request'] = conversation.id
    const event = { requestId: 'stream-request', type: 'done' as const, runId: 'run-title', status: 'completed' as const, answer: '最终回答' }
    store.handleAgentStreamEvent(event)
    store.handleAgentStreamEvent(event)
    await vi.waitFor(() => expect(conversation.title).toBe('项目文档整理'))
    expect(generateTitle).toHaveBeenCalledTimes(1)
    expect(generateTitle).toHaveBeenCalledWith('请帮我整理项目文档', '最终回答')
  })

  it.each(['error', 'empty', 'rejected'])('retains fallback after %s and retries with the original successful answer', async failure => {
    if (failure === 'rejected') generateTitle.mockRejectedValueOnce(new Error('连接失败'))
    else generateTitle.mockResolvedValueOnce(failure === 'error' ? { success: false, error: '请求失败' } : { success: true, data: { title: '' } })
    const conversation = setupConversation()
    finish(conversation.id)
    await vi.waitFor(() => expect(Object.keys(useAiAssistantStore().conversationTitleRequests)).toHaveLength(0))
    expect(conversation.title).toBe('请帮我整理项目文档')
    expect(conversation.titleGenerated).not.toBe(true)
    finish(conversation.id, '另一个回答')
    await vi.waitFor(() => expect(conversation.title).toBe('项目文档整理'))
    expect(generateTitle).toHaveBeenNthCalledWith(2, '请帮我整理项目文档', '已完成项目整理')
  })

  it('does not generate for cancellation, empty answers or manually named conversations', async () => {
    const conversation = setupConversation()
    finish(conversation.id, '部分回答', 'cancelled')
    finish(conversation.id, '')
    useWorkspaceStore().renameAiAssistantConversation(conversation.id, '我的标题')
    finish(conversation.id)
    await Promise.resolve()
    expect(generateTitle).not.toHaveBeenCalled()
  })

  it('skips the empty-answer placeholder when a later turn succeeds', async () => {
    const conversation = setupConversation()
    finish(conversation.id, '')
    finish(conversation.id, '真实回答')
    await vi.waitFor(() => expect(generateTitle).toHaveBeenCalledWith('请帮我整理项目文档', '真实回答'))
  })

  it('bounds inputs and never includes system messages or tool metadata', async () => {
    const conversation = setupConversation()
    conversation.messages[0].text = '问'.repeat(3000)
    useWorkspaceStore().appendAiAssistantMessageToConversation(conversation.id, 'system', '不应发送的系统摘要')
    finish(conversation.id, '答'.repeat(5000))
    await vi.waitFor(() => expect(generateTitle).toHaveBeenCalledWith('问'.repeat(2000), '答'.repeat(4000)))
  })

  it('keeps the generated title protected after reloading persisted state', async () => {
    const conversation = setupConversation()
    finish(conversation.id)
    await vi.waitFor(() => expect(conversation.title).toBe('项目文档整理'))
    const saved = persist.mock.lastCall![1]
    ;(window.electronAPI.workspaceAi as any).get = vi.fn().mockResolvedValue({ success: true, data: saved })
    await useWorkspaceStore().loadAiAssistantState('ws')
    const restored = useWorkspaceStore().getAiAssistantConversationById(conversation.id)!
    useWorkspaceStore().appendAiAssistantMessageToConversation(restored.id, 'user', '下一步')
    expect(restored).toMatchObject({ title: '项目文档整理', titleGenerated: true })
  })
  it('generates once after a successful answer without blocking completion or changing history order', async () => {
    const conversation = setupConversation()
    finish(conversation.id)
    const updatedAt = conversation.updatedAt
    expect(useAiAssistantStore().agentRunsByConversationId[conversation.id]).toBeUndefined()
    await vi.waitFor(() => expect(conversation.title).toBe('项目文档整理'))
    expect(generateTitle).toHaveBeenCalledWith('请帮我整理项目文档', '已完成项目整理')
    expect(conversation).toMatchObject({ titleGenerated: true, updatedAt })
    expect(conversation.titleEdited).not.toBe(true)
    expect(persist.mock.lastCall?.[1].conversations.find((item: any) => item.id === conversation.id)).toMatchObject({ title: '项目文档整理', titleGenerated: true })
    useWorkspaceStore().appendAiAssistantMessageToConversation(conversation.id, 'user', '继续整理')
    finish(conversation.id, '后续回答')
    await Promise.resolve()
    expect(conversation.title).toBe('项目文档整理')
    expect(generateTitle).toHaveBeenCalledTimes(1)
  })
})
