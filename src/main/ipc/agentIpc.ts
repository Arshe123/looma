import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { ipcMain, type WebContents } from 'electron'
import type { AgentEvent, AgentSource, FilePatchArtifact, JsonValue } from '../../shared/types/agent-events'
import type { AgentMessage } from '../../shared/types/agent-message'
import type { AgentRun, AgentTask } from '../../shared/types/agent-state'
import { createEventSnapshot, foldAgentState } from '../../shared/utils/agent-event-projections'
import { AgentArtifactStore } from '../services/agent/AgentArtifactStore'
import { AgentLedgerStore } from '../services/agent/AgentLedgerStore'
import {
  aiService,
  normalizeAgentRunOptions,
  type AgentRunOptions,
  type AgentStreamEvent,
} from '../services/ai/AIService'
import { getWorkspacePathById } from './workspaceIpc'

const MAX_ACTIVE_AGENT_RUNS_PER_SENDER = 4
const MAX_ACTIVE_AGENT_RUNS_GLOBAL = 32

type ActiveAgentRun = {
  controller: AbortController
  sender: WebContents
  onDestroyed: () => void
  workspaceId: string
  workspacePath: string
  taskId: string
  runId: string
  conversationId: string
  inputMessageId: string
  assistantMessageId: string
  startedAt: number
  nextEventSequence: number
  ledger: AgentLedgerStore | null
  artifactStore: AgentArtifactStore | null
  callInputDigests: Map<string, string>
  approvals: Map<string, { artifactId: string; deadlineAt: string; status: 'pending' | 'resolving' | 'resolved' }>
}

export const activeAgentRuns = new Map<string, ActiveAgentRun>()

const runKey = (senderId: number, requestId: string) => `${senderId}:${requestId}`
const validIdentifier = (value: unknown): value is string => typeof value === 'string'
  && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)

const cleanupRun = (key: string, run: ActiveAgentRun) => {
  if (activeAgentRuns.get(key) !== run) return
  activeAgentRuns.delete(key)
  run.sender.removeListener('destroyed', run.onDestroyed)
}

export const abortAllAgentRuns = () => {
  for (const [key, run] of activeAgentRuns) {
    run.controller.abort()
    cleanupRun(key, run)
  }
}

const eventId = () => `evt_${randomUUID().replace(/-/g, '')}`
const messageId = () => `msg_${randomUUID().replace(/-/g, '')}`
const digestJson = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
const asJsonRecord = (value: Record<string, unknown>) => JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>
const sensitiveArgumentKey = /(api[-_]?key|token|authorization|cookie|password|passwd|secret|credential|private[-_]?key|access[-_]?key)/i
const sanitizeToolArguments = (value: unknown, depth = 0): unknown => {
  if (depth >= 4) return '[truncated]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.length > 800 ? `${value.slice(0, 800)}…` : value
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeToolArguments(item, depth + 1))
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([key, item]) => [
    key,
    sensitiveArgumentKey.test(key) ? '[REDACTED]' : sanitizeToolArguments(item, depth + 1),
  ]))
}
const withEventBase = (
  run: ActiveAgentRun,
  family: AgentEvent['family'],
  type: AgentEvent['type'],
  payload: AgentEvent['payload'],
): AgentEvent => ({
  id: eventId(),
  sequence: run.nextEventSequence++,
  taskId: run.taskId,
  runId: run.runId,
  timestamp: Date.now(),
  family,
  type,
  payload,
} as AgentEvent)

const persistSnapshot = async (run: ActiveAgentRun) => {
  if (!run.ledger) return
  const view = await run.ledger.materialize()
  const events = view.events.filter(event => event.runId === run.runId)
  if (!events.length) return
  const throughSequence = Math.max(...events.map(event => event.sequence))
  const eventLogPrefixHash = await run.ledger.eventLogPrefixHash(run.runId, throughSequence)
  const snapshot = createEventSnapshot(run.runId, events, eventLogPrefixHash)
  await run.ledger.writeSnapshot({
    cacheVersion: 1,
    taskId: run.taskId,
    runId: run.runId,
    eventLogPrefixHash,
    throughSequence,
    value: snapshot,
  })
}

const persistCheckpoint = async (
  run: ActiveAgentRun,
  nextStep: number,
  pendingApprovalRef?: { approvalId: string; artifactId: string; callId: string },
) => {
  if (!run.ledger) return
  const view = await run.ledger.materialize()
  const events = view.events.filter(event => event.runId === run.runId)
  const messages = view.messages.filter(message => message.runId === run.runId)
  if (!events.length || !messages.length) return
  const throughSequence = Math.max(...events.map(event => event.sequence))
  const eventLogPrefixHash = await run.ledger.eventLogPrefixHash(run.runId, throughSequence)
  const messageTranscriptHash = digestJson(messages)
  await run.ledger.writeCheckpoint({
    cacheVersion: 1,
    taskId: run.taskId,
    runId: run.runId,
    eventLogPrefixHash,
    throughSequence,
    value: {
      version: 1,
      taskId: run.taskId,
      runId: run.runId,
      throughSequence,
      eventLogPrefixHash,
      messageCursor: messages[messages.length - 1].id,
      messageTranscriptHash,
      nextStep,
      remainingToolSteps: Math.max(0, 50 - run.callInputDigests.size),
      completedCallDigests: [...run.callInputDigests.values()],
      pendingApprovalRef,
    },
  })
}

const persistStreamEvent = async (run: ActiveAgentRun, requestId: string, payload: AgentStreamEvent) => {
  const ledger = run.ledger
  if (!ledger) throw new Error('Agent ledger is not initialized')

  if (payload.runId !== run.runId) throw new Error('Agent stream run ID mismatch')
  switch (payload.type) {
    case 'run_started': {
      const agentEvent = withEventBase(run, 'execution', 'agent_started', {
        requestId,
        inputMessageId: run.inputMessageId,
        assistantMessageId: run.assistantMessageId,
        modelIdentity: { provider: 'unknown', model: 'unknown' },
        contextVersion: 1,
      })
      await ledger.commit({ kind: 'event_commit', events: [agentEvent] })
      break
    }
    case 'tool_call': {
      if (payload.thought_summary.trim()) {
        await ledger.commit({
          kind: 'event_commit',
          events: [withEventBase(run, 'execution', 'thought_summary', {
            stepId: payload.stepId,
            callId: payload.callId,
            summary: payload.thought_summary,
          })],
        })
      }
      const argumentsDigest = digestJson(payload.arguments)
      run.callInputDigests.set(payload.callId, argumentsDigest)
      const callEvent = withEventBase(run, 'execution', 'tool_call_requested', {
        stepId: payload.stepId,
        callId: payload.callId,
        tool: payload.tool,
        argumentsPreview: asJsonRecord(sanitizeToolArguments(payload.arguments) as Record<string, unknown>),
        argumentsDigest,
        startedAt: Date.now(),
      })
      const assistantMessage: AgentMessage = {
        id: messageId(),
        conversationId: run.conversationId,
        taskId: run.taskId,
        runId: run.runId,
        role: 'assistant',
        content: null,
        createdAt: Date.now(),
        tool_calls: [{ id: payload.callId, type: 'function', function: { name: payload.tool, arguments: payload.arguments } }],
      }
      await ledger.commitToolCall(callEvent, assistantMessage, {
        callId: payload.callId,
        taskId: run.taskId,
        runId: run.runId,
        tool: payload.tool,
        status: 'pending',
        updatedAt: Date.now(),
      })
      break
    }
    case 'tool_result': {
      const resultEvent = withEventBase(run, 'execution', 'tool_result_recorded', {
        stepId: payload.stepId,
        callId: payload.callId,
        tool: payload.result.tool,
        status: payload.result.status,
        durationMs: payload.result.durationMs,
        uiSummary: payload.result.uiSummary,
        modelContext: {
          facts: payload.result.modelContext.facts,
          structuredData: asJsonRecord(payload.result.modelContext.structuredData),
        },
        error: payload.result.error ? {
          code: payload.result.error.code,
          message: payload.result.error.message,
          technicalDetail: payload.result.error.technical_detail ?? undefined,
          recoverable: payload.result.error.retryable,
        } : undefined,
      })
      const modelPayload = {
        tool: payload.result.tool,
        success: payload.result.success,
        status: payload.result.status,
        modelContext: payload.result.modelContext,
        error: payload.result.error,
        truncated: payload.result.truncated,
      }
      const toolMessage: AgentMessage = {
        id: messageId(),
        conversationId: run.conversationId,
        taskId: run.taskId,
        runId: run.runId,
        role: 'tool',
        content: JSON.stringify(modelPayload),
        createdAt: Date.now(),
        tool_call_id: payload.callId,
        name: payload.result.tool,
      }
      await ledger.commitToolResult(resultEvent, toolMessage, {
        callId: payload.callId,
        taskId: run.taskId,
        runId: run.runId,
        tool: payload.result.tool,
        status: payload.result.success ? 'completed' : 'failed',
        updatedAt: Date.now(),
        resultEventId: resultEvent.id,
      })
      await persistCheckpoint(run, payload.step + 1)
      break
    }
    case 'approval_required': {
      if (!run.artifactStore) throw new Error('Agent artifact store is not initialized')
      const artifactId = `artifact_${randomUUID().replace(/-/g, '')}`
      const beforeHash = payload.proposal.expected_sha256 ? `sha256:${payload.proposal.expected_sha256}` : null
      const afterHash = `sha256:${payload.proposal.proposed_sha256}`
      const expiresAt = Date.parse(payload.deadlineAt)
      const artifact: FilePatchArtifact = {
        artifactId,
        taskId: run.taskId,
        runId: run.runId,
        callId: payload.callId,
        approvalId: payload.approvalId,
        workspaceId: run.workspaceId,
        path: payload.proposal.path,
        operation: payload.proposal.operation,
        beforeHash,
        afterHash,
        diff: payload.proposal.unified_diff,
        proposedContent: payload.proposal.proposed_content,
        createdAt: Date.parse(payload.requestedAt) || Date.now(),
        expiresAt,
      }
      await run.artifactStore.save(artifact)
      const diffLines = artifact.diff.split('\n')
      const events: AgentEvent[] = [
        withEventBase(run, 'artifact', 'artifact_created', {
          artifactId,
          callId: payload.callId,
          kind: 'file_patch',
          path: artifact.path,
          beforeHash,
          afterHash,
          operation: artifact.operation,
          diff: artifact.diff,
          createdAt: artifact.createdAt,
          expiresAt: artifact.expiresAt,
          additions: diffLines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length,
          deletions: diffLines.filter(line => line.startsWith('-') && !line.startsWith('---')).length,
        }),
        withEventBase(run, 'artifact', 'approval_required', {
          approvalId: payload.approvalId,
          callId: payload.callId,
          artifactId,
          deadlineAt: expiresAt,
        }),
      ]
      await ledger.commit({ kind: 'event_commit', events })
      run.approvals.set(payload.approvalId, { artifactId, deadlineAt: payload.deadlineAt, status: 'pending' })
      await persistCheckpoint(run, payload.step + 1, {
        approvalId: payload.approvalId,
        artifactId,
        callId: payload.callId,
      })
      await persistSnapshot(run)
      break
    }
    case 'approval_resolved': {
      const approval = run.approvals.get(payload.approvalId)
      if (!approval) break
      await ledger.commit({
        kind: 'event_commit',
        events: [withEventBase(run, 'artifact', 'approval_resolved', {
          approvalId: payload.approvalId,
          callId: payload.callId,
          artifactId: approval.artifactId,
          status: payload.resolution.status,
          applied: payload.resolution.applied === true,
          reason: payload.resolution.reason ?? undefined,
        })],
      })
      break
    }
    case 'sources': {
      const sources: AgentSource[] = payload.sources.map((source) => ({
        sourceId: String(source.sourceId),
        retrievalId: payload.retrievalId,
        taskId: run.taskId,
        runId: run.runId,
        path: typeof source.path === 'string' ? source.path : '',
        snippet: typeof source.text === 'string' ? source.text.slice(0, 2000) : '',
        score: typeof source.score === 'number' && Number.isFinite(source.score) ? source.score : undefined,
      }))
      await ledger.commit({
        kind: 'source_commit',
        sources,
        events: [withEventBase(run, 'execution', 'retrieval_completed', {
          retrievalId: payload.retrievalId,
          callId: payload.callId,
          tool: 'rag_search',
          queryDigest: run.callInputDigests.get(payload.callId) ?? digestJson({}),
          sourceIds: sources.map(source => source.sourceId),
          sourceCount: sources.length,
          durationMs: 0,
        })],
      })
      break
    }
    case 'usage_updated': {
      await ledger.commit({
        kind: 'event_commit',
        events: [withEventBase(run, 'execution', 'usage_updated', {
          operationId: payload.operationId,
          phase: payload.phase,
          provider: payload.provider,
          model: payload.model,
          inputTokens: payload.inputTokens,
          outputTokens: payload.outputTokens,
          totalTokens: payload.totalTokens,
          cost: payload.cost,
          latencyMs: payload.latencyMs,
        })],
      })
      break
    }
    case 'continuation_created': {
      await ledger.commit({
        kind: 'event_commit',
        events: [withEventBase(run, 'recovery', 'continuation_created', {
          parentRunId: payload.parentRunId,
          recoveryReason: payload.recoveryReason,
        })],
      })
      break
    }
    case 'done': {
      const terminalEvent = payload.status === 'cancelled'
        ? withEventBase(run, 'execution', 'run_cancelled', { reason: 'cancelled' })
        : withEventBase(run, 'execution', 'run_completed', { answerMessageId: run.assistantMessageId })
      const messages: AgentMessage[] = []
      if (payload.status === 'completed' && typeof payload.answer === 'string') {
        messages.push({
          id: run.assistantMessageId,
          conversationId: run.conversationId,
          taskId: run.taskId,
          runId: run.runId,
          role: 'assistant',
          content: payload.answer,
          createdAt: Date.now(),
        })
      }
      await ledger.commit({ kind: 'event_commit', events: [terminalEvent], messages })
      await persistSnapshot(run)
      break
    }
    case 'error': {
      await ledger.commit({
        kind: 'event_commit',
        events: [withEventBase(run, 'execution', 'run_failed', {
          code: payload.error.code,
          message: payload.error.message,
          technicalDetail: payload.error.technical_detail ?? undefined,
          recoverable: payload.error.retryable,
        })],
      })
      await persistSnapshot(run)
      break
    }
    case 'timeline':
    case 'delta':
      break
  }
}

const sendEvent = async (
  key: string,
  run: ActiveAgentRun,
  requestId: string,
  payload: AgentStreamEvent,
) => {
  if (activeAgentRuns.get(key) !== run || run.controller.signal.aborted || run.sender.isDestroyed()) return
  const firstSequence = run.nextEventSequence
  await persistStreamEvent(run, requestId, payload)
  const ledgerView = run.nextEventSequence > firstSequence && run.ledger
    ? await run.ledger.materialize()
    : null
  const agentEvents = ledgerView
    ? ledgerView.events.filter((agentEvent) => (
      agentEvent.runId === run.runId
      && agentEvent.sequence >= firstSequence
      && agentEvent.sequence < run.nextEventSequence
    ))
    : []
  const retrievalIds = new Set<string>()
  for (const agentEvent of agentEvents) {
    if (agentEvent.type === 'retrieval_completed') retrievalIds.add(agentEvent.payload.retrievalId)
  }
  const agentSources = ledgerView
    ? ledgerView.sources.filter((source) => source.runId === run.runId && retrievalIds.has(source.retrievalId))
    : []
  if (payload.type === 'approval_required') {
    run.sender.send('agent:runStream:event', {
      ...payload,
      agentEvents,
      agentSources,
      proposal: { ...payload.proposal, proposed_content: '' },
      requestId,
    })
    return
  }
  if (payload.type === 'approval_resolved') run.approvals.delete(payload.approvalId)
  run.sender.send('agent:runStream:event', { ...payload, agentEvents, agentSources, requestId })
}

const buildContinuationHistory = (messages: AgentMessage[]): AgentRunOptions['history'] => {
  const pendingCalls = new Map<string, number>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    for (const call of message.tool_calls || []) pendingCalls.set(call.id, index)
    if (message.role === 'tool' && message.tool_call_id) pendingCalls.delete(message.tool_call_id)
  }
  const safeLength = pendingCalls.size ? Math.min(...pendingCalls.values()) : messages.length
  return messages.slice(0, safeLength).map(message => ({
    role: message.role,
    content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {}),
  }))
}

ipcMain.handle('agent:summarizeConversation', async (_event, messages: unknown, maxChars: unknown) => {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100) {
    return { success: false, error: 'Invalid Agent summary messages' }
  }
  const normalized = messages
    .filter((message): message is { role: 'user' | 'assistant' | 'system'; content: string } => Boolean(
      message && typeof message === 'object'
      && ['user', 'assistant', 'system'].includes((message as any).role)
      && typeof (message as any).content === 'string'
      && (message as any).content.trim(),
    ))
    .map(message => ({ role: message.role, content: message.content.trim() }))
  const limit = Math.min(8000, Math.max(200, Math.round(Number(maxChars) || 1600)))
  if (!normalized.length) return { success: false, error: 'Agent summary messages are empty' }
  return aiService.summarizeAgentConversation(normalized, limit)
})

ipcMain.handle('agent:ledger:getRun', async (_event, workspaceId: unknown, runId: unknown) => {
  if (!validIdentifier(workspaceId) || !validIdentifier(runId)) {
    return { success: false, error: 'Invalid Agent ledger request' }
  }
  const workspacePath = await getWorkspacePathById(workspaceId)
  if (!workspacePath) return { success: false, error: 'Workspace not found' }
  try {
    const ledger = new AgentLedgerStore(path.join(workspacePath, '.looma', 'agent-ledger'))
    const [view, auditIssues] = await Promise.all([ledger.materialize(), ledger.audit()])
    const run = view.runs[runId]
    if (!run) return { success: false, error: 'Agent run not found' }
    const runEvents = view.events.filter(agentEvent => agentEvent.runId === runId)
    const runSources = view.sources.filter(source => source.runId === runId)
    const runAuditIssues = auditIssues.filter(issue => issue.runId === runId || (issue.callId && runEvents.some(agentEvent => (
      (agentEvent.type === 'tool_call_requested' || agentEvent.type === 'tool_result_recorded') && agentEvent.payload.callId === issue.callId
    ))))
    const state = foldAgentState(runEvents)
    const throughSequence = runEvents.length ? Math.max(...runEvents.map(agentEvent => agentEvent.sequence)) : 0
    const prefixHash = await ledger.eventLogPrefixHash(runId, throughSequence)
    const checkpoint = throughSequence > 0 ? await ledger.readCheckpoint(runId, prefixHash) : null
    const task = view.tasks[run.taskId] || null
    const hasPendingApproval = state.status === 'waiting_approval'
    const alreadyContinued = Boolean(task?.latestRunId && task.latestRunId !== runId)
    const recoverable = ['failed', 'cancelled'].includes(state.status) && !hasPendingApproval && !alreadyContinued
    return {
      success: true,
      data: {
        task,
        run,
        events: runEvents,
        sources: runSources,
        auditIssues: runAuditIssues,
        recovery: {
          recoverable,
          checkpointAvailable: Boolean(checkpoint),
          reason: alreadyContinued
            ? '任务已在新的后续运行中继续。'
            : hasPendingApproval
              ? '请先处理待审批的文件修改。'
              : recoverable
                ? checkpoint ? '安全检查点可用。' : '将从已确认的事件和消息继续。'
                : '当前运行状态不支持继续。',
        },
      },
    }
  } catch {
    return { success: false, error: 'Unable to read Agent ledger' }
  }
})

ipcMain.handle('agent:runStream:start', async (event, requestId: unknown, workspaceId: unknown, rawOptions: unknown) => {
  if (!validIdentifier(requestId)) return { success: false, error: 'Invalid Agent request ID' }
  if (!validIdentifier(workspaceId)) return { success: false, error: 'Invalid workspace ID' }

  let options: ReturnType<typeof normalizeAgentRunOptions>
  try {
    const rendererOptions = rawOptions && typeof rawOptions === 'object'
      ? rawOptions as Pick<AgentRunOptions, 'input' | 'history'>
      : {} as Pick<AgentRunOptions, 'input' | 'history'>
    // Tool capabilities and execution limits are product policy, not renderer/user settings.
    options = normalizeAgentRunOptions({
      input: rendererOptions.input,
      history: rendererOptions.history,
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Invalid Agent options' }
  }

  const sender = event.sender
  if (sender.isDestroyed()) return { success: false, error: 'Agent window is no longer available' }
  const key = runKey(sender.id, requestId)
  const previous = activeAgentRuns.get(key)
  if (previous) {
    previous.controller.abort()
    cleanupRun(key, previous)
  }

  const senderRunCount = [...activeAgentRuns.values()].filter(run => run.sender.id === sender.id).length
  if (senderRunCount >= MAX_ACTIVE_AGENT_RUNS_PER_SENDER || activeAgentRuns.size >= MAX_ACTIVE_AGENT_RUNS_GLOBAL) {
    return { success: false, error: 'Too many active Agent runs' }
  }

  const controller = new AbortController()
  const startedAt = Date.now()
  const taskId = `task_${randomUUID().replace(/-/g, '')}`
  const runId = `run_${randomUUID().replace(/-/g, '')}`
  const conversationId = `conversation_${taskId}`
  const inputMessageId = messageId()
  const assistantMessageId = messageId()
  const run: ActiveAgentRun = {
    controller,
    sender,
    workspaceId,
    workspacePath: '',
    taskId,
    runId,
    conversationId,
    inputMessageId,
    assistantMessageId,
    startedAt,
    nextEventSequence: 1,
    ledger: null,
    artifactStore: null,
    callInputDigests: new Map(),
    approvals: new Map(),
    onDestroyed: () => {
      controller.abort()
      cleanupRun(key, run)
    },
  }
  activeAgentRuns.set(key, run)
  sender.once('destroyed', run.onDestroyed)

  let workspacePath: string | null
  try {
    workspacePath = await getWorkspacePathById(workspaceId)
  } catch {
    cleanupRun(key, run)
    return { success: false, error: 'Unable to resolve workspace' }
  }
  if (activeAgentRuns.get(key) !== run || controller.signal.aborted || sender.isDestroyed()) {
    cleanupRun(key, run)
    return { success: false, error: 'Agent request was cancelled' }
  }
  if (!workspacePath) {
    cleanupRun(key, run)
    return { success: false, error: 'Workspace not found' }
  }
  run.workspacePath = workspacePath
  try {
    const ledgerRoot = path.join(workspacePath, '.looma', 'agent-ledger')
    run.ledger = new AgentLedgerStore(ledgerRoot)
    run.artifactStore = new AgentArtifactStore(ledgerRoot)
    await Promise.all([run.ledger.init(), run.artifactStore.init()])
    const task: AgentTask = {
      id: taskId,
      conversationId,
      goal: options.input,
      constraints: [],
      createdAt: startedAt,
      updatedAt: startedAt,
      status: 'active',
      runIds: [runId],
      activeRunId: runId,
      latestRunId: runId,
      policy: {
        maxRuns: 8,
        maxTotalToolCalls: 50,
        maxTotalModelCalls: 64,
        maxTotalWallTimeMs: 30 * 60 * 1000,
      },
    }
    const runRecord: AgentRun = {
      id: runId,
      taskId,
      conversationId,
      requestId,
      inputMessageId,
      assistantMessageId,
      createdAt: startedAt,
    }
    const userMessage: AgentMessage = {
      id: inputMessageId,
      conversationId,
      taskId,
      runId,
      role: 'user',
      content: options.input,
      createdAt: startedAt,
    }
    await run.ledger.commit({ kind: 'task_created', tasks: [task], runs: [runRecord], messages: [userMessage] })
  } catch {
    cleanupRun(key, run)
    return { success: false, error: 'Unable to initialize Agent ledger' }
  }

  void aiService.streamAgent(
    workspacePath,
    { ...options, taskId, runId },
    payload => sendEvent(key, run, requestId, payload),
    controller.signal,
  ).then(async (result) => {
    if (!result.success) {
      await sendEvent(key, run, requestId, {
        type: 'error',
        runId: run.runId,
        error: {
          code: 'agent_bridge_failed',
          message: 'Agent 服务暂时不可用，请稍后重试。',
          technical_detail: 'AgentBridgeError',
          retryable: true,
        },
      }).catch(() => {})
    }
  }).catch(async () => {
    await sendEvent(key, run, requestId, {
      type: 'error',
      runId: run.runId,
      error: {
        code: 'agent_bridge_failed',
        message: 'Agent 服务暂时不可用，请稍后重试。',
        technical_detail: 'AgentBridgeError',
        retryable: true,
      },
    }).catch(() => {})
  }).finally(() => cleanupRun(key, run))

  return { success: true, data: { taskId, runId } }
})

ipcMain.handle('agent:runStream:resume', async (event, requestId: unknown, workspaceId: unknown, parentRunId: unknown) => {
  if (!validIdentifier(requestId) || !validIdentifier(workspaceId) || !validIdentifier(parentRunId)) {
    return { success: false, error: 'Invalid Agent continuation request' }
  }
  const sender = event.sender
  if (sender.isDestroyed()) return { success: false, error: 'Agent window is no longer available' }
  const senderRunCount = [...activeAgentRuns.values()].filter(run => run.sender.id === sender.id).length
  if (senderRunCount >= MAX_ACTIVE_AGENT_RUNS_PER_SENDER || activeAgentRuns.size >= MAX_ACTIVE_AGENT_RUNS_GLOBAL) {
    return { success: false, error: 'Too many active Agent runs' }
  }
  const workspacePath = await getWorkspacePathById(workspaceId)
  if (!workspacePath) return { success: false, error: 'Workspace not found' }

  try {
    const ledgerRoot = path.join(workspacePath, '.looma', 'agent-ledger')
  const ledger = new AgentLedgerStore(ledgerRoot)
  const artifactStore = new AgentArtifactStore(ledgerRoot)
  await Promise.all([ledger.init(), artifactStore.init()])
  const view = await ledger.materialize()
  const parentRun = view.runs[parentRunId]
  if (!parentRun) return { success: false, error: 'Parent Agent run not found' }
  const task = view.tasks[parentRun.taskId]
  if (!task) return { success: false, error: 'Agent task not found' }
  const parentEvents = view.events.filter(agentEvent => agentEvent.runId === parentRunId)
  const parentState = foldAgentState(parentEvents)
  if (!['failed', 'cancelled'].includes(parentState.status)) {
    return { success: false, error: parentState.status === 'waiting_approval' ? '请先处理待审批的文件修改。' : '当前运行状态不支持继续。' }
  }
  if (task.runIds.length >= task.policy.maxRuns) return { success: false, error: '该任务已达到最大运行次数。' }
  if ([...activeAgentRuns.values()].some(run => run.taskId === task.id)) return { success: false, error: '该任务已有后续运行正在执行。' }

  const runId = `run_${randomUUID().replace(/-/g, '')}`
  const input = '请基于上次运行中已确认的事实继续完成任务；不要重复已经成功完成的操作。'
  const history = buildContinuationHistory(view.messages.filter(message => message.conversationId === parentRun.conversationId))
  let options: ReturnType<typeof normalizeAgentRunOptions>
  try {
    options = normalizeAgentRunOptions({
      input,
      history,
      taskId: task.id,
      runId,
      parentRunId,
      recoveryReason: 'manual_retry',
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to rebuild Agent continuation context' }
  }

  const key = runKey(sender.id, requestId)
  const previous = activeAgentRuns.get(key)
  if (previous) {
    previous.controller.abort()
    cleanupRun(key, previous)
  }
  const controller = new AbortController()
  const startedAt = Date.now()
  const run: ActiveAgentRun = {
    controller,
    sender,
    workspaceId,
    workspacePath,
    taskId: task.id,
    runId,
    conversationId: parentRun.conversationId,
    inputMessageId: messageId(),
    assistantMessageId: messageId(),
    startedAt,
    nextEventSequence: 1,
    ledger,
    artifactStore,
    callInputDigests: new Map(),
    approvals: new Map(),
    onDestroyed: () => {
      controller.abort()
      cleanupRun(key, run)
    },
  }
  activeAgentRuns.set(key, run)
  sender.once('destroyed', run.onDestroyed)

  const nextTask: AgentTask = {
    ...task,
    status: 'active',
    updatedAt: startedAt,
    runIds: [...task.runIds, runId],
    activeRunId: runId,
    latestRunId: runId,
  }
  const runRecord: AgentRun = {
    id: runId,
    taskId: task.id,
    conversationId: parentRun.conversationId,
    requestId,
    inputMessageId: run.inputMessageId,
    assistantMessageId: run.assistantMessageId,
    parentRunId,
    recoveryReason: 'manual_retry',
    createdAt: startedAt,
  }
  const userMessage: AgentMessage = {
    id: run.inputMessageId,
    conversationId: parentRun.conversationId,
    taskId: task.id,
    runId,
    role: 'user',
    content: input,
    createdAt: startedAt,
  }
  try {
    await ledger.commit({ kind: 'run_created', tasks: [nextTask], runs: [runRecord], messages: [userMessage] })
  } catch {
    cleanupRun(key, run)
    return { success: false, error: 'Unable to persist Agent continuation' }
  }

  void aiService.streamAgent(
    workspacePath,
    options,
    payload => sendEvent(key, run, requestId, payload),
    controller.signal,
  ).then(async (result) => {
    if (!result.success) {
      await sendEvent(key, run, requestId, {
        type: 'error',
        runId,
        error: { code: 'agent_bridge_failed', message: 'Agent 服务暂时不可用，请稍后重试。', technical_detail: 'AgentBridgeError', retryable: true },
      }).catch(() => {})
    }
  }).catch(async () => {
    await sendEvent(key, run, requestId, {
      type: 'error',
      runId,
      error: { code: 'agent_bridge_failed', message: 'Agent 服务暂时不可用，请稍后重试。', technical_detail: 'AgentBridgeError', retryable: true },
    }).catch(() => {})
  }).finally(() => cleanupRun(key, run))

    return { success: true, data: { taskId: task.id, runId, parentRunId } }
  } catch (error) {
    return {
      success: false,
      error: '无法创建后续运行，请稍后重试。',
      technicalDetail: error instanceof Error ? error.message : String(error),
    }
  }
})

ipcMain.handle('agent:runStream:cancel', async (event, requestId: unknown) => {
  if (!validIdentifier(requestId)) return { success: false, error: 'Invalid Agent request ID' }
  const key = runKey(event.sender.id, requestId)
  const run = activeAgentRuns.get(key)
  let agentEvents: AgentEvent[] = []
  if (run) {
    if (run.ledger) {
      const cancelledEvent = withEventBase(run, 'execution', 'run_cancelled', { reason: 'user_cancelled' })
      await run.ledger.commit({
        kind: 'event_commit',
        events: [cancelledEvent],
      }).then(() => { agentEvents = [cancelledEvent] }).catch(() => {})
    }
    run.controller.abort()
    cleanupRun(key, run)
  }
  return { success: true, data: { agentEvents } }
})

ipcMain.handle('agent:approval:resolve', async (event, approvalId: unknown, approved: unknown) => {
  if (!validIdentifier(approvalId) || typeof approved !== 'boolean') {
    return { success: false, error: 'Invalid Agent approval request' }
  }
  const match = [...activeAgentRuns.entries()].find(([, run]) => run.sender.id === event.sender.id && run.approvals.has(approvalId))
  if (!match) return { success: false, error: '审批已失效或不属于当前窗口' }
  const [, run] = match
  const approval = run.approvals.get(approvalId)!
  if (approval.status !== 'pending') return { success: false, error: '审批正在处理，请勿重复操作' }
  if (!run.artifactStore || !run.ledger) return { success: false, error: 'Agent Artifact 存储不可用' }
  let artifact: FilePatchArtifact
  try {
    artifact = await run.artifactStore.load(approval.artifactId)
  } catch {
    return { success: false, error: '文件修改提案已损坏或不可读取' }
  }
  if (!Number.isFinite(Date.parse(approval.deadlineAt)) || Date.now() >= Date.parse(approval.deadlineAt)) {
    await run.ledger.commit({
      kind: 'event_commit',
      events: [withEventBase(run, 'artifact', 'approval_resolved', {
        approvalId,
        callId: artifact.callId,
        artifactId: artifact.artifactId,
        status: 'expired',
        applied: false,
        reason: 'approval_expired',
      })],
    }).catch(() => {})
    run.approvals.delete(approvalId)
    return { success: false, error: '审批已过期，请让 Agent 重新生成修改提案' }
  }
  approval.status = 'resolving'

  let applied = false
  let reason = approved ? undefined : '用户拒绝了文件修改'
  const artifactEvents: AgentEvent[] = []
  if (approved) {
    try {
      const result = await run.artifactStore.apply(run.workspacePath, run.workspaceId, approval.artifactId)
      if (result.status === 'applied' || result.status === 'already_applied') {
        applied = true
        artifactEvents.push(withEventBase(run, 'artifact', 'file_patch_applied', {
          approvalId,
          artifactId: artifact.artifactId,
          callId: artifact.callId,
          path: result.path,
          beforeHash: result.beforeHash,
          afterHash: result.afterHash,
        }))
      } else {
        reason = '文件已在审批期间发生变化，请重新生成修改提案'
        artifactEvents.push(withEventBase(run, 'artifact', 'file_patch_conflict', {
          approvalId,
          artifactId: artifact.artifactId,
          callId: artifact.callId,
          path: result.path,
          expectedHash: result.expectedHash,
          actualHash: result.actualHash,
        }))
      }
    } catch {
      reason = '应用文件修改失败'
      artifactEvents.push(withEventBase(run, 'artifact', 'file_patch_failed', {
        approvalId,
        artifactId: artifact.artifactId,
        callId: artifact.callId,
        path: artifact.path,
        code: 'patch_apply_failed',
        message: reason,
      }))
    }
  }
  artifactEvents.push(withEventBase(run, 'artifact', 'approval_resolved', {
    approvalId,
    callId: artifact.callId,
    artifactId: artifact.artifactId,
    status: approved ? 'approved' : 'rejected',
    applied,
    reason,
  }))
  await run.ledger.commit({ kind: 'event_commit', events: artifactEvents })
  approval.status = 'resolved'

  let resolved: Awaited<ReturnType<typeof aiService.resolveAgentApproval>> = { success: false, error: '审批服务不可用' }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    resolved = await aiService.resolveAgentApproval(
      approvalId,
      approved ? 'approved' : 'rejected',
      reason,
      applied,
    )
    if (resolved.success) break
  }
  if (!resolved.success) {
    return {
      success: false,
      error: applied
        ? '文件已经安全写入，但 Agent 未能恢复执行。可稍后创建 continuation run。'
        : '审批结果已经记录，但 Agent 服务未能继续执行。可稍后创建 continuation run。',
    }
  }
  run.approvals.delete(approvalId)
  return applied || !approved
    ? { success: true, data: { applied } }
    : { success: false, error: reason || '文件修改未能应用', errorCode: 'AGENT_PATCH_APPLY_FAILED' }
})
