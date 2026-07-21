import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiAssistantStore } from '../ai-assistant'
import { useSettingsStore } from '../settings'
import { useWorkspaceStore } from '../workspace'

const canonicalEvent = (
  runId: string,
  sequence: number,
  family: 'execution' | 'artifact' | 'recovery',
  type: string,
  payload: Record<string, unknown>,
) => ({ id: `evt-${runId}-${sequence}-${type}`, taskId: 'task-1', runId, sequence, timestamp: 1_000 + sequence, family, type, payload }) as any

const agentApi = {
  start: vi.fn().mockResolvedValue({ success: true, data: { taskId: 'task-1', runId: 'run-main' } }),
  cancel: vi.fn().mockResolvedValue({
    success: true,
    data: { agentEvents: [canonicalEvent('run-cancel', 2, 'execution', 'run_cancelled', { reason: 'user_cancelled' })] },
  }),
  onEvent: vi.fn(() => vi.fn()),
}

const installElectronApiStub = () => {
  ;(globalThis as any).window = globalThis.window || globalThis
  ;(globalThis as any).window.electronAPI = {
    workspaceAi: { set: vi.fn().mockResolvedValue({ success: true }) },
    rag: {
      indexStream: {
        start: vi.fn().mockResolvedValue({ success: true }),
        cancel: vi.fn().mockResolvedValue({ success: true }),
        onEvent: vi.fn(() => vi.fn()),
      },
    },
    agent: {
      runStream: agentApi,
      resolveApproval: vi.fn().mockResolvedValue({ success: true, data: { applied: true } }),
      summarizeConversation: vi.fn().mockResolvedValue({ success: true, data: { answer: '摘要' } }),
    },
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

  it('creates request IDs accepted by the Agent IPC boundary', () => {
    const requestId = useAiAssistantStore().createStreamRequestId()

    expect(requestId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
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

  it('persists bounded redacted tool arguments without tool bubbles, raw observations, or private reasoning', async () => {
    const conversationId = createConversation()
    const run = await startAgent(conversationId)
    const store = useAiAssistantStore()
    const workspace = useWorkspaceStore()
    const beforeMessageCount = workspace.getAiAssistantConversationById(conversationId)!.messages.length
    const hugeObservation = `SECRET-${'x'.repeat(20_000)}`

    store.handleAgentStreamEvent({
      requestId: run.requestId,
      type: 'timeline',
      runId: 'run-compact',
      step: 1,
      stepId: 'step-1',
      status: 'running',
      summary: '接下来读取文件',
    })
    store.handleAgentStreamEvent({
      requestId: run.requestId,
      type: 'tool_call',
      runId: 'run-compact',
      step: 1,
      stepId: 'step-1',
      callId: 'call-1',
      tool: 'file_read',
      arguments: { path: 'secret.md' },
      thought_summary: 'hidden chain of thought',
      agentEvents: [
        canonicalEvent('run-compact', 1, 'execution', 'thought_summary', { stepId: 'step-1', callId: 'call-1', summary: 'hidden chain of thought' }),
        canonicalEvent('run-compact', 2, 'execution', 'tool_call_requested', {
          stepId: 'step-1', callId: 'call-1', tool: 'file_read',
          argumentsPreview: { path: 'secret.md', apiKey: '[REDACTED]' }, argumentsDigest: 'sha256:test', startedAt: 1_002,
        }),
      ],
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
        status: 'completed',
        uiSummary: '已读取 docs/guide.md',
        modelContext: { facts: ['文件已读取'], structuredData: { path: 'docs/guide.md' } },
        error: null,
        truncated: false,
      },
      agentEvents: [canonicalEvent('run-compact', 3, 'execution', 'tool_result_recorded', {
        stepId: 'step-1', callId: 'call-1', tool: 'file_read', status: 'completed', durationMs: 12,
        uiSummary: '已读取 docs/guide.md', modelContext: { facts: ['文件已读取'], structuredData: { path: 'docs/guide.md' } },
      })],
    })
    store.handleAgentStreamEvent({
      requestId: run.requestId,
      type: 'sources',
      runId: 'run-compact',
      sources: [{ path: 'docs/guide.md', text: '片段内容'.repeat(100), score: 0.9 }],
      agentEvents: [canonicalEvent('run-compact', 4, 'execution', 'retrieval_completed', {
        retrievalId: 'retrieval-1', callId: 'call-1', tool: 'rag_search', queryDigest: 'sha256:q',
        sourceIds: ['source-1'], sourceCount: 1, durationMs: 8,
      })],
      agentSources: [{ sourceId: 'source-1', retrievalId: 'retrieval-1', taskId: 'task-1', runId: 'run-compact', path: 'docs/guide.md', snippet: '片段内容', score: 0.9 }],
    })

    const conversation = workspace.getAiAssistantConversationById(conversationId)!
    const assistant = conversation.messages.find(message => message.id === run.assistantMessageId)!
    const serialized = JSON.stringify(assistant)
    expect(conversation.messages).toHaveLength(beforeMessageCount)
    expect(conversation.messages.some(message => (message.role as string) === 'tool')).toBe(false)
    expect(assistant.timeline?.some(step => step.detail?.includes('已读取 docs/guide.md'))).toBe(true)
    expect(assistant.timeline?.flatMap(step => step.outputs).some(output => output.path === 'docs/guide.md')).toBe(true)
    const persistedArguments = assistant.timeline
      ?.find(step => step.id === 'step-1')
      ?.outputs.find(output => output.title === '调用参数')?.content
    expect(persistedArguments).toContain('secret.md')
    expect(persistedArguments).toContain('[REDACTED]')
    expect(persistedArguments).not.toContain('never-save-this')
    expect((persistedArguments?.length || 0)).toBeLessThanOrEqual(4_000)
    expect(serialized).not.toContain(hugeObservation)
    expect(serialized).not.toContain('never-save-this')
    expect(serialized).not.toContain('hidden chain of thought')
    expect(serialized.length).toBeLessThan(5_000)

    const displayEvents = store.getMessageAgentDisplayEvents(conversationId, run.assistantMessageId)
    expect(displayEvents.map(event => event.kind)).toEqual(['thought', 'tool_call'])
    expect(displayEvents[0]?.content).toBe('hidden chain of thought')
    expect(displayEvents[1]?.argumentsPreview).toContain('secret.md')
    expect(displayEvents[1]?.argumentsPreview).toContain('[REDACTED]')
    expect(displayEvents[1]?.argumentsPreview).not.toContain('never-save-this')
    expect(displayEvents[1]).toMatchObject({ kind: 'tool_call', status: 'completed' })
    expect(JSON.stringify(displayEvents)).not.toContain(hugeObservation)
    expect(JSON.stringify(displayEvents)).not.toContain('已读取 docs/guide.md')
  })

  it('persists every RAG source returned by the Agent', async () => {
    const conversationId = createConversation()
    const run = await startAgent(conversationId)
    const store = useAiAssistantStore()
    const sources = Array.from({ length: 12 }, (_, index) => ({
      path: `docs/source-${index + 1}.md`,
      text: `来源片段 ${index + 1}`,
      score: 1 - index / 100,
    }))

    store.handleAgentStreamEvent({
      requestId: run.requestId,
      type: 'sources',
      runId: 'run-all-sources',
      sources,
      agentEvents: [canonicalEvent('run-all-sources', 1, 'execution', 'retrieval_completed', {
        retrievalId: 'retrieval-all', callId: 'call-search', tool: 'rag_search', queryDigest: 'sha256:q',
        sourceIds: sources.map((_, index) => `source-${index + 1}`), sourceCount: sources.length, durationMs: 20,
      })],
      agentSources: sources.map((source, index) => ({
        sourceId: `source-${index + 1}`, retrievalId: 'retrieval-all', taskId: 'task-1', runId: 'run-all-sources',
        path: source.path, snippet: source.text, score: source.score,
      })),
    })

    const message = useWorkspaceStore().getAiAssistantConversationById(conversationId)!.messages
      .find(item => item.id === run.assistantMessageId)!
    const sourceOutputs = message.timeline
      ?.find(step => step.id === 'agent-sources')
      ?.outputs.filter(output => output.type === 'source')
    expect(sourceOutputs).toHaveLength(12)
    expect(sourceOutputs?.at(-1)?.path).toBe('docs/source-12.md')
    expect(message.agentSummary?.sourceCount).toBe(12)
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


  it('deduplicates tool events by callId and does not regress a completed result', async () => {
    const conversationId = createConversation()
    const run = await startAgent(conversationId)
    const store = useAiAssistantStore()
    const result = {
      requestId: run.requestId,
      type: 'tool_result' as const,
      runId: 'run-dedupe', step: 1, stepId: 'step-1', callId: 'call-1',
      result: {
        tool: 'file_read', success: true, status: 'completed', uiSummary: '读取完成',
        modelContext: { facts: ['读取完成'], structuredData: {} }, error: null, truncated: false,
      },
      agentEvents: [canonicalEvent('run-dedupe', 2, 'execution', 'tool_result_recorded', {
        stepId: 'step-1', callId: 'call-1', tool: 'file_read', status: 'completed', durationMs: 10,
        uiSummary: '读取完成', modelContext: { facts: ['读取完成'], structuredData: {} },
      })],
    }
    store.handleAgentStreamEvent(result)
    store.handleAgentStreamEvent(result)
    store.handleAgentStreamEvent({
      requestId: run.requestId, type: 'tool_call', runId: 'run-dedupe', step: 1,
      stepId: 'step-1', callId: 'call-1', tool: 'file_read', arguments: { path: 'late.md', token: 'late-secret' }, thought_summary: '',
      agentEvents: [canonicalEvent('run-dedupe', 1, 'execution', 'tool_call_requested', {
        stepId: 'step-1', callId: 'call-1', tool: 'file_read',
        argumentsPreview: { path: 'late.md', token: '[REDACTED]' }, argumentsDigest: 'sha256:late', startedAt: 1_001,
      })],
    })

    const currentMessage = useWorkspaceStore().getAiAssistantConversationById(conversationId)!.messages
      .find(item => item.id === run.assistantMessageId)!
    expect(currentMessage.agentSummary?.toolCallCount).toBe(1)
    const completedStep = currentMessage.timeline?.find(step => step.id === 'step-1')
    expect(completedStep?.status).toBe('completed')
    const persistedArguments = completedStep?.outputs.find(output => output.title === '调用参数')?.content
    expect(persistedArguments).toContain('late.md')
    expect(persistedArguments).toContain('[REDACTED]')
    expect(persistedArguments).not.toContain('late-secret')
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
      agentEvents: [canonicalEvent('run-cancel', 1, 'execution', 'tool_call_requested', {
        stepId: 'step-active', callId: 'call-active', tool: 'file_read',
        argumentsPreview: {}, argumentsDigest: 'sha256:empty', startedAt: 1_001,
      })],
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
        tool: 'file_read', success: false, status: 'failed', uiSummary: '读取失败',
        modelContext: { facts: [], structuredData: {} },
        error: { code: 'workspace_security_error', message: '无法读取文件。', technical_detail: 'WorkspaceSecurityError', recoverable: false },
        truncated: false,
      },
      agentEvents: [
        canonicalEvent('run-tool-error', 1, 'execution', 'tool_call_requested', {
          stepId: 'step-error', callId: 'call-error', tool: 'file_read', argumentsPreview: {}, argumentsDigest: 'sha256:empty', startedAt: 1_001,
        }),
        canonicalEvent('run-tool-error', 2, 'execution', 'tool_result_recorded', {
          stepId: 'step-error', callId: 'call-error', tool: 'file_read', status: 'failed', durationMs: 9,
          uiSummary: '读取失败', modelContext: { facts: [], structuredData: {} },
          error: { code: 'workspace_security_error', message: '无法读取文件。', technicalDetail: 'WorkspaceSecurityError', recoverable: false },
        }),
      ],
    })

    const message = useWorkspaceStore().getAiAssistantConversationById(conversationId)!.messages
      .find(item => item.id === run.assistantMessageId)!
    expect(message.timeline?.find(step => step.id === 'step-error')?.outputs.find(output => output.type === 'error')).toMatchObject({
      type: 'error',
      content: '读取失败',
      technicalDetail: 'WorkspaceSecurityError',
    })
  })

  it('stores file proposals and resolves them through the Agent approval API', async () => {
    const conversationId = createConversation()
    const run = await startAgent(conversationId)
    const store = useAiAssistantStore()
    store.handleAgentStreamEvent({
      requestId: run.requestId,
      type: 'approval_required',
      runId: 'run-approval',
      step: 1,
      stepId: 'step-1',
      callId: 'call-1',
      approvalId: 'approval-1',
      tool: 'file_patch',
      proposal: { path: 'notes/a.md', operation: 'update', unified_diff: '--- a\n+++ a\n-old\n+new' },
      requestedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      agentEvents: [
        canonicalEvent('run-approval', 1, 'execution', 'tool_call_requested', {
          stepId: 'step-1', callId: 'call-1', tool: 'file_patch', argumentsPreview: { path: 'notes/a.md' }, argumentsDigest: 'sha256:patch', startedAt: 1_001,
        }),
        canonicalEvent('run-approval', 2, 'artifact', 'artifact_created', {
          artifactId: 'artifact-1', callId: 'call-1', kind: 'file_patch', path: 'notes/a.md',
          beforeHash: 'sha256:before', afterHash: 'sha256:after', operation: 'update', diff: '--- a\n+++ a\n-old\n+new',
          additions: 1, deletions: 1, createdAt: 1_002, expiresAt: Date.now() + 60_000,
        }),
        canonicalEvent('run-approval', 3, 'artifact', 'approval_required', {
          approvalId: 'approval-1', callId: 'call-1', artifactId: 'artifact-1', deadlineAt: Date.now() + 60_000,
        }),
      ],
    })

    expect(store.getConversationAgentApprovals(conversationId)).toEqual([
      expect.objectContaining({ approvalId: 'approval-1', path: 'notes/a.md', status: 'pending' }),
    ])
    const result = await store.resolveAgentApproval(conversationId, 'approval-1', true)
    expect((window as any).electronAPI.agent.resolveApproval).toHaveBeenCalledWith('approval-1', true)
    expect(result).toEqual({ success: true })
    expect(store.getConversationAgentApprovals(conversationId)[0].status).toBe('resolving')
  })
})
