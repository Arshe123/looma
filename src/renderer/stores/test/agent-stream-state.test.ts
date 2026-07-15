import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiAssistantStore } from '../ai-assistant'
import { useSettingsStore } from '../settings'
import { useWorkspaceStore } from '../workspace'

const agentApi = {
  start: vi.fn().mockResolvedValue({ success: true }),
  cancel: vi.fn().mockResolvedValue({ success: true }),
  onEvent: vi.fn(() => vi.fn()),
}

const installElectronApiStub = () => {
  ;(globalThis as any).window = globalThis.window || globalThis
  ;(globalThis as any).window.electronAPI = {
    workspaceAi: { set: vi.fn().mockResolvedValue({ success: true }) },
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
    agent: { runStream: agentApi },
  }
}

const createConversation = () => {
  const workspace = useWorkspaceStore()
  workspace.startTemporaryAiAssistantConversation()
  return workspace.ensureAiAssistantConversationForRequest()
}

const startAgent = async (conversationId: string, text = '检查工作空间') => {
  const store = useAiAssistantStore()
  const result = await store.startAgentInConversation({
    workspaceId: 'workspace-1',
    conversationId,
    text,
    aiName: 'GPT 4o Mini',
  })
  expect(result).toEqual({ success: true })
  const run = store.agentRunsByConversationId[conversationId]
  expect(run).toBeTruthy()
  return run
}

describe('agent stream state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    installElectronApiStub()
    const settings = useSettingsStore()
    settings.settings.ai.chat.provider = 'openai'
    settings.settings.ai.chat.model = 'gpt-4o-mini'
  })

  it('snapshots model identity at request time and keeps the user prompt as a user bubble', async () => {
    const conversationId = createConversation()
    const run = await startAgent(conversationId)
    const workspace = useWorkspaceStore()
    const conversation = workspace.getAiAssistantConversationById(conversationId)!

    expect(agentApi.start).toHaveBeenCalledWith(run.requestId, 'workspace-1', expect.objectContaining({
      input: '检查工作空间',
    }))
    expect(conversation.messages.at(-2)).toMatchObject({ role: 'user', text: '检查工作空间' })
    expect(conversation.messages.at(-1)).toMatchObject({
      role: 'assistant',
      mode: 'agent',
      modelIdentity: { provider: 'openai', model: 'gpt-4o-mini', displayName: 'GPT 4o Mini' },
    })

    useSettingsStore().settings.ai.chat.model = 'gpt-5-later'
    useAiAssistantStore().handleAgentStreamEvent({
      requestId: run.requestId,
      type: 'run_started',
      runId: 'run-1',
      startedAt: new Date().toISOString(),
    })

    expect(conversation.messages.at(-1)?.modelIdentity).toEqual({
      provider: 'openai', model: 'gpt-4o-mini', displayName: 'GPT 4o Mini',
    })
    expect(conversation.messages.at(-1)?.runId).toBe('run-1')
  })

  it('routes events to the request conversation after the active conversation changes', async () => {
    const workspace = useWorkspaceStore()
    const conversationA = createConversation()
    const run = await startAgent(conversationA)
    const assistantMessageId = run.assistantMessageId

    workspace.startTemporaryAiAssistantConversation()
    const conversationB = workspace.ensureAiAssistantConversationForRequest()

    useAiAssistantStore().handleAgentStreamEvent({
      requestId: run.requestId,
      type: 'delta',
      runId: 'run-a',
      text: '原会话回答',
      content: '原会话回答',
    })

    expect(workspace.getAiAssistantConversationById(conversationA)?.messages.find(message => message.id === assistantMessageId)?.text)
      .toBe('原会话回答')
    expect(workspace.getAiAssistantConversationById(conversationB)?.messages.some(message => message.text.includes('原会话回答')))
      .toBe(false)
  })

  it('maps tool and source events into a compact timeline without tool bubbles or sensitive payloads', async () => {
    const conversationId = createConversation()
    const run = await startAgent(conversationId)
    const store = useAiAssistantStore()
    const workspace = useWorkspaceStore()
    const beforeMessageCount = workspace.getAiAssistantConversationById(conversationId)!.messages.length
    const hugeObservation = `SECRET-${'x'.repeat(20_000)}`

    store.handleAgentStreamEvent({
      requestId: run.requestId,
      type: 'tool_call',
      runId: 'run-compact',
      step: 1,
      stepId: 'step-1',
      callId: 'call-1',
      tool: 'file_read',
      arguments: { path: 'secret.md', apiKey: 'never-save-this' },
      thought_summary: 'hidden chain of thought',
    })
    store.handleAgentStreamEvent({
      requestId: run.requestId,
      type: 'tool_result',
      runId: 'run-compact',
      step: 1,
      stepId: 'step-1',
      callId: 'call-1',
      result: {
        tool: 'file_read',
        success: true,
        summary: '已读取 docs/guide.md',
        data: { observation: hugeObservation },
        error: null,
        truncated: false,
      },
    })
    store.handleAgentStreamEvent({
      requestId: run.requestId,
      type: 'sources',
      runId: 'run-compact',
      sources: [{ path: 'docs/guide.md', text: '片段内容'.repeat(100), score: 0.9, apiKey: 'never-save-this' }],
    })

    const conversation = workspace.getAiAssistantConversationById(conversationId)!
    const assistant = conversation.messages.find(message => message.id === run.assistantMessageId)!
    const serialized = JSON.stringify(assistant)
    expect(conversation.messages).toHaveLength(beforeMessageCount)
    expect(conversation.messages.some(message => (message.role as string) === 'tool')).toBe(false)
    expect(assistant.timeline?.some(step => step.detail?.includes('已读取 docs/guide.md'))).toBe(true)
    expect(assistant.timeline?.flatMap(step => step.outputs).some(output => output.path === 'docs/guide.md')).toBe(true)
    expect(serialized).not.toContain(hugeObservation)
    expect(serialized).not.toContain('never-save-this')
    expect(serialized).not.toContain('hidden chain of thought')
    expect(serialized.length).toBeLessThan(5_000)
  })

  it('persists a friendly error and technical detail, then removes the run mapping', async () => {
    const conversationId = createConversation()
    const run = await startAgent(conversationId)
    const store = useAiAssistantStore()

    store.handleAgentStreamEvent({
      requestId: run.requestId,
      type: 'error',
      runId: 'run-error',
      error: {
        code: 'TOOL_TIMEOUT',
        message: '读取文件超时，请重试。',
        technical_detail: 'file_read exceeded 30s',
        retryable: true,
      },
    })

    const message = useWorkspaceStore().getAiAssistantConversationById(conversationId)!.messages
      .find(item => item.id === run.assistantMessageId)!
    expect(message.text).toBe('读取文件超时，请重试。')
    expect(message.agentSummary).toMatchObject({
      status: 'error',
      error: { message: '读取文件超时，请重试。', technicalDetail: 'file_read exceeded 30s' },
    })
    expect(store.agentRunsByConversationId[conversationId]).toBeUndefined()
    expect(store.agentRequestIdToConversationId[run.requestId]).toBeUndefined()
  })

  it('cancels through the agent API and ignores late events', async () => {
    const conversationId = createConversation()
    const run = await startAgent(conversationId)
    const store = useAiAssistantStore()
    const workspace = useWorkspaceStore()

    await store.cancelAgentConversation(conversationId)
    const textAfterCancel = workspace.getAiAssistantConversationById(conversationId)!.messages
      .find(message => message.id === run.assistantMessageId)!.text
    store.handleAgentStreamEvent({
      requestId: run.requestId,
      type: 'delta',
      runId: 'run-late',
      text: '迟到内容',
      content: '迟到内容',
    })

    expect(agentApi.cancel).toHaveBeenCalledWith(run.requestId)
    expect(store.agentRunsByConversationId[conversationId]).toBeUndefined()
    expect(store.agentRequestIdToConversationId[run.requestId]).toBeUndefined()
    expect(workspace.getAiAssistantConversationById(conversationId)!.messages
      .find(message => message.id === run.assistantMessageId)!.text).toBe(textAfterCancel)
  })

  it('starts without consulting RAG index state', async () => {
    const conversationId = createConversation()
    const store = useAiAssistantStore()
    store.indexResultsByWorkspaceId['workspace-1'] = { exists: false, documentCount: 0 }

    await startAgent(conversationId, '列出文件')

    expect(agentApi.start).toHaveBeenCalledOnce()
  })

  it('locks the conversation before asynchronous history preparation', async () => {
    const conversationId = createConversation()
    const store = useAiAssistantStore()
    let resolveHistory!: (value: { history: []; stats: Record<string, never> }) => void
    vi.spyOn(store, 'buildConversationHistoryForRequest').mockImplementation(() => new Promise(resolve => {
      resolveHistory = resolve as typeof resolveHistory
    }) as any)

    const first = store.startAgentInConversation({ workspaceId: 'workspace-1', conversationId, text: '第一次', aiName: 'AI' })
    const second = await store.startAgentInConversation({ workspaceId: 'workspace-1', conversationId, text: '第二次', aiName: 'AI' })
    expect(second.success).toBe(false)

    resolveHistory({ history: [], stats: {} })
    await first
    expect(agentApi.start).toHaveBeenCalledOnce()
  })

  it('cancels an Agent during history preparation without starting IPC', async () => {
    const conversationId = createConversation()
    const store = useAiAssistantStore()
    let resolveHistory!: (value: { history: []; stats: Record<string, never> }) => void
    vi.spyOn(store, 'buildConversationHistoryForRequest').mockImplementation(() => new Promise(resolve => {
      resolveHistory = resolve as typeof resolveHistory
    }) as any)

    const start = store.startAgentInConversation({ workspaceId: 'workspace-1', conversationId, text: '稍后取消', aiName: 'AI' })
    expect(store.isConversationRunningAgent(conversationId)).toBe(true)
    expect(await store.cancelAgentConversation(conversationId)).toEqual({ success: true })
    resolveHistory({ history: [], stats: {} })

    expect(await start).toEqual({ success: true, cancelled: true })
    expect(agentApi.start).not.toHaveBeenCalled()
    expect(store.agentStartingConversationIds[conversationId]).toBeUndefined()
  })

  it('locks RAG during history preparation against an Agent start', async () => {
    const conversationId = createConversation()
    const store = useAiAssistantStore()
    let resolveHistory!: (value: { history: []; stats: Record<string, never> }) => void
    vi.spyOn(store, 'buildConversationHistoryForRequest').mockImplementation(() => new Promise(resolve => {
      resolveHistory = resolve as typeof resolveHistory
    }) as any)

    const ragStart = store.askInConversation({ workspaceId: 'workspace-1', conversationId, text: 'RAG 问题', aiName: 'AI' })
    expect(store.isConversationAsking(conversationId)).toBe(true)
    const agentStart = await store.startAgentInConversation({ workspaceId: 'workspace-1', conversationId, text: 'Agent 问题', aiName: 'AI' })
    expect(agentStart.success).toBe(false)

    resolveHistory({ history: [], stats: {} })
    await ragStart
    expect((window as any).electronAPI.rag.askStream.start).toHaveBeenCalledOnce()
  })

  it('deduplicates tool events by callId and does not regress a completed result', async () => {
    const conversationId = createConversation()
    const run = await startAgent(conversationId)
    const store = useAiAssistantStore()
    const result = {
      requestId: run.requestId,
      type: 'tool_result' as const,
      runId: 'run-dedupe', step: 1, stepId: 'step-1', callId: 'call-1',
      result: { tool: 'file_read', success: true, summary: '读取完成' },
    }
    store.handleAgentStreamEvent(result)
    store.handleAgentStreamEvent(result)
    store.handleAgentStreamEvent({
      requestId: run.requestId, type: 'tool_call', runId: 'run-dedupe', step: 1,
      stepId: 'step-1', callId: 'call-1', tool: 'file_read', arguments: {}, thought_summary: '',
    })

    const currentRun = store.agentRunsByConversationId[conversationId]
    expect(currentRun.toolCallCount).toBe(1)
    expect(currentRun.timeline.find(step => step.id === 'step-1')?.status).toBe('completed')
  })

  it('keeps the run mapped when cancellation is rejected', async () => {
    agentApi.cancel.mockResolvedValueOnce({ success: false, error: '取消失败' })
    const conversationId = createConversation()
    const run = await startAgent(conversationId)
    const store = useAiAssistantStore()

    const result = await store.cancelAgentConversation(conversationId)

    expect(result).toEqual({ success: false, error: '取消失败' })
    expect(store.agentRunsByConversationId[conversationId]?.requestId).toBe(run.requestId)
    expect(store.agentRequestIdToConversationId[run.requestId]).toBe(conversationId)
  })

  it('finishes active timeline steps when cancellation succeeds', async () => {
    const conversationId = createConversation()
    const run = await startAgent(conversationId)
    const store = useAiAssistantStore()
    store.handleAgentStreamEvent({
      requestId: run.requestId, type: 'tool_call', runId: 'run-cancel', step: 1,
      stepId: 'step-active', callId: 'call-active', tool: 'file_read', arguments: {}, thought_summary: '',
    })

    await store.cancelAgentConversation(conversationId)

    const message = useWorkspaceStore().getAiAssistantConversationById(conversationId)!.messages
      .find(item => item.id === run.assistantMessageId)!
    expect(message.agentSummary?.status).toBe('cancelled')
    expect(message.timeline?.every(step => step.status !== 'active' && step.status !== 'pending')).toBe(true)
    expect(message.timeline?.find(step => step.id === 'step-active')).toMatchObject({
      status: 'completed',
      detail: '运行已取消。',
    })
    expect(message.timeline?.find(step => step.id === 'step-active')?.endedAt).toEqual(expect.any(Number))
  })

  it('persists tool failure technical detail in the collapsed error output', async () => {
    const conversationId = createConversation()
    const run = await startAgent(conversationId)
    const store = useAiAssistantStore()
    store.handleAgentStreamEvent({
      requestId: run.requestId, type: 'tool_result', runId: 'run-tool-error', step: 1,
      stepId: 'step-error', callId: 'call-error',
      result: {
        tool: 'file_read', success: false, summary: '读取失败',
        error: { message: '无法读取文件。', technical_detail: 'WorkspaceSecurityError' },
      },
    })

    const message = useWorkspaceStore().getAiAssistantConversationById(conversationId)!.messages
      .find(item => item.id === run.assistantMessageId)!
    expect(message.timeline?.find(step => step.id === 'step-error')?.outputs[0]).toMatchObject({
      type: 'error',
      content: '读取失败',
      technicalDetail: 'WorkspaceSecurityError',
    })
  })
})
