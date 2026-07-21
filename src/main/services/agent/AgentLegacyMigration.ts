import { createHash } from 'node:crypto'
import path from 'node:path'
import type { AgentEvent, AgentSource, JsonValue } from '../../../shared/types/agent-events'
import type { AgentMessage, AgentToolName } from '../../../shared/types/agent-message'
import type { AgentRun, AgentTask } from '../../../shared/types/agent-state'
import type { AgentOutboxEntry } from './agentLedgerTypes'
import { AgentLedgerStore } from './AgentLedgerStore'

interface LegacyTimelineOutput {
  id: string
  type: 'text' | 'source' | 'metric' | 'code' | 'json' | 'error'
  title?: string
  content?: string
  technicalDetail?: string
  path?: string
  metadata?: Record<string, unknown>
}

interface LegacyTimelineStep {
  id: string
  title: string
  detail?: string
  status: 'pending' | 'active' | 'completed' | 'error'
  startedAt: number
  endedAt?: number
  outputs: LegacyTimelineOutput[]
}

interface LegacyAgentMessage {
  id: number
  role: 'assistant' | 'user' | 'system'
  text: string
  createdAt: number
  timeline?: LegacyTimelineStep[]
  taskId?: string
  runId?: string
  mode?: 'rag' | 'agent'
  modelIdentity?: { provider: string; model: string; displayName: string }
  agentSummary?: {
    status: 'running' | 'completed' | 'cancelled' | 'error'
    toolCallCount?: number
    sourceCount?: number
    error?: { message: string; technicalDetail?: string }
  }
}

export interface LegacyAgentConversation {
  id: string
  messages: LegacyAgentMessage[]
}

export interface LegacyAgentState {
  schemaVersion?: number
  conversations: LegacyAgentConversation[]
}

export interface LegacyAgentMigrationResult<T extends LegacyAgentState> {
  state: T
  migratedRunIds: string[]
}

const tools = new Set<AgentToolName>(['rag_search', 'workspace_list', 'workspace_search', 'file_read', 'file_patch'])
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stableId = (prefix: string, ...parts: Array<string | number>) => `${prefix}_${digest(parts).slice(0, 24)}`
const safeText = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const asJsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue

const parseArguments = (step: LegacyTimelineStep): Record<string, JsonValue> => {
  const output = step.outputs.find(item => item.type === 'json' && item.title === '调用参数')
  if (!output?.content) return {}
  try {
    const parsed = JSON.parse(output.content)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? asJsonValue(parsed) as Record<string, JsonValue>
      : {}
  } catch {
    return {}
  }
}

const inferTool = (step: LegacyTimelineStep): AgentToolName | null => {
  const match = step.title.match(/(?:调用|执行)\s+([a-z_]+)/i)
  const candidate = match?.[1] as AgentToolName | undefined
  return candidate && tools.has(candidate) ? candidate : null
}

const buildMigratedRun = (
  conversation: LegacyAgentConversation,
  message: LegacyAgentMessage,
  previousUserMessage: LegacyAgentMessage | undefined,
) => {
  const taskId = message.taskId || stableId('task_migrated', conversation.id, message.id)
  const runId = message.runId || stableId('run_migrated', conversation.id, message.id)
  const requestId = stableId('request_migrated', conversation.id, message.id)
  const inputMessageId = previousUserMessage
    ? stableId('message_migrated', conversation.id, previousUserMessage.id)
    : stableId('message_migrated_input', conversation.id, message.id)
  const assistantMessageId = stableId('message_migrated', conversation.id, message.id)
  const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
  const events: AgentEvent[] = []
  const sources: AgentSource[] = []
  const outbox: AgentOutboxEntry[] = []
  let sequence = 0
  const event = (family: AgentEvent['family'], type: AgentEvent['type'], payload: unknown, timestamp = createdAt + sequence + 1) => {
    sequence += 1
    events.push({
      id: stableId('event_migrated', runId, sequence, type),
      taskId,
      runId,
      sequence,
      timestamp,
      family,
      type,
      payload,
    } as AgentEvent)
  }

  event('execution', 'agent_started', {
    requestId,
    inputMessageId,
    assistantMessageId,
    modelIdentity: {
      provider: message.modelIdentity?.provider || 'legacy',
      model: message.modelIdentity?.model || 'unknown',
    },
    contextVersion: 0,
  }, createdAt)

  for (const step of message.timeline || []) {
    const tool = inferTool(step)
    if (tool) {
      const callId = stableId('call_migrated', runId, step.id)
      const argumentsPreview = parseArguments(step)
      event('execution', 'tool_call_requested', {
        stepId: step.id,
        callId,
        tool,
        argumentsPreview,
        argumentsDigest: `sha256:${digest(argumentsPreview)}`,
        startedAt: step.startedAt,
      }, step.startedAt)
      if (step.status === 'completed' || step.status === 'error') {
        const failed = step.status === 'error'
        const errorOutput = step.outputs.find(output => output.type === 'error')
        const summary = safeText(errorOutput?.content || step.detail || (failed ? '旧版工具调用失败。' : '旧版工具调用已完成。'), 1_000)
        event('execution', 'tool_result_recorded', {
          stepId: step.id,
          callId,
          tool,
          status: failed ? 'failed' : 'completed',
          durationMs: Math.max(0, (step.endedAt || step.startedAt) - step.startedAt),
          uiSummary: summary,
          modelContext: { facts: summary ? [summary] : [], structuredData: {} },
          ...(failed ? {
            error: {
              code: 'legacy_tool_error',
              message: summary || '旧版工具调用失败。',
              technicalDetail: safeText(errorOutput?.technicalDetail, 2_000) || undefined,
              recoverable: false,
            },
          } : {}),
        }, step.endedAt || step.startedAt)
        outbox.push({
          callId,
          taskId,
          runId,
          tool,
          status: failed ? 'failed' : 'completed',
          updatedAt: step.endedAt || step.startedAt,
          resultEventId: events.at(-1)?.id,
        })
      } else {
        outbox.push({ callId, taskId, runId, tool, status: 'pending', updatedAt: step.startedAt })
      }
    }

    const sourceOutputs = step.outputs.filter(output => output.type === 'source' && safeText(output.path, 500))
    if (sourceOutputs.length) {
      const retrievalId = stableId('retrieval_migrated', runId, step.id)
      const retrievalCallId = stableId('call_migrated_retrieval', runId, step.id)
      for (const [index, output] of sourceOutputs.entries()) {
        const score = typeof output.metadata?.score === 'number' && Number.isFinite(output.metadata.score)
          ? output.metadata.score
          : undefined
        sources.push({
          sourceId: stableId('source_migrated', runId, step.id, index),
          retrievalId,
          taskId,
          runId,
          path: safeText(output.path, 500),
          snippet: safeText(output.content, 2_000),
          score,
        })
      }
      event('execution', 'retrieval_completed', {
        retrievalId,
        callId: retrievalCallId,
        tool: 'rag_search',
        queryDigest: `sha256:${digest({ migrated: true, stepId: step.id })}`,
        sourceIds: sources.filter(source => source.retrievalId === retrievalId).map(source => source.sourceId),
        sourceCount: sourceOutputs.length,
        durationMs: Math.max(0, (step.endedAt || step.startedAt) - step.startedAt),
      }, step.endedAt || step.startedAt)
    }
  }

  const status = message.agentSummary?.status || 'completed'
  if (status === 'running') {
    event('recovery', 'run_interrupted', { reason: 'app_restart', recoverable: false })
    event('recovery', 'recovery_failed', {
      parentRunId: runId,
      code: 'legacy_checkpoint_unavailable',
      message: '旧版运行记录缺少可验证的运行检查点，无法自动继续。',
    })
  } else if (status === 'cancelled') {
    event('execution', 'run_cancelled', { reason: 'legacy_cancelled' })
  } else if (status === 'error') {
    event('execution', 'run_failed', {
      code: 'legacy_run_failed',
      message: safeText(message.agentSummary?.error?.message, 1_000) || '旧版 Agent 运行失败。',
      technicalDetail: safeText(message.agentSummary?.error?.technicalDetail, 2_000) || undefined,
      recoverable: false,
    })
  } else {
    event('execution', 'run_completed', { answerMessageId: assistantMessageId })
  }

  const taskStatus: AgentTask['status'] = status === 'completed'
    ? 'completed'
    : status === 'cancelled'
      ? 'cancelled'
      : 'failed'
  const endedAt = events.at(-1)?.timestamp || createdAt
  const task: AgentTask = {
    id: taskId,
    conversationId: conversation.id,
    goal: safeText(previousUserMessage?.text, 2_000) || '迁移的旧版 Agent 任务',
    constraints: ['由旧版时间线迁移；不可假定存在可恢复运行时状态。'],
    createdAt,
    updatedAt: endedAt,
    status: taskStatus,
    runIds: [runId],
    latestRunId: runId,
    policy: {
      maxRuns: 8,
      maxTotalToolCalls: 64,
      maxTotalModelCalls: 32,
      maxTotalWallTimeMs: 30 * 60 * 1_000,
    },
  }
  const run: AgentRun = {
    id: runId,
    taskId,
    conversationId: conversation.id,
    requestId,
    inputMessageId,
    assistantMessageId,
    createdAt,
    endedAt,
  }
  const messages: AgentMessage[] = []
  if (previousUserMessage?.text.trim()) {
    messages.push({
      id: inputMessageId,
      conversationId: conversation.id,
      taskId,
      runId,
      role: 'user',
      content: previousUserMessage.text,
      createdAt: previousUserMessage.createdAt,
    })
  }
  if (message.text.trim()) {
    messages.push({
      id: assistantMessageId,
      conversationId: conversation.id,
      taskId,
      runId,
      role: 'assistant',
      content: message.text,
      createdAt,
    })
  }
  return { taskId, runId, task, run, messages, events, sources, outbox, interrupted: status === 'running' }
}

export const migrateLegacyAgentState = async <T extends LegacyAgentState>(
  workspacePath: string,
  state: T,
): Promise<LegacyAgentMigrationResult<T>> => {
  const ledger = new AgentLedgerStore(path.join(workspacePath, '.looma', 'agent-ledger'))
  const view = await ledger.materialize()
  const migratedRunIds: string[] = []

  for (const conversation of state.conversations) {
    for (let index = 0; index < conversation.messages.length; index += 1) {
      const message = conversation.messages[index]
      if (message.role !== 'assistant' || message.mode !== 'agent' || !(message.timeline?.length || message.agentSummary)) continue
      const previousUserMessage = [...conversation.messages.slice(0, index)].reverse().find(item => item.role === 'user')
      const migrated = buildMigratedRun(conversation, message, previousUserMessage)
      message.taskId = migrated.taskId
      message.runId = migrated.runId
      message.timeline = undefined
      if (migrated.interrupted) {
        message.agentSummary = {
          status: 'error',
          toolCallCount: migrated.outbox.length,
          sourceCount: migrated.sources.length,
          error: { message: '旧版运行已中断，可查看历史记录，但需要重新发起任务。' },
        }
      }
      if (view.runs[migrated.runId]) continue
      await ledger.commit({
        kind: 'event_commit',
        tasks: [migrated.task],
        runs: [migrated.run],
        messages: migrated.messages,
        events: migrated.events,
        sources: migrated.sources,
        outbox: migrated.outbox,
      })
      view.runs[migrated.runId] = migrated.run
      migratedRunIds.push(migrated.runId)
    }
  }
  state.schemaVersion = 2
  return { state, migratedRunIds }
}
