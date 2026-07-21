import type { AgentEvent, ToolResultModelContext, UsageUpdatePayload } from '../types/agent-events'
import type { AgentState } from '../types/agent-state'
import type { AgentToolName } from '../types/agent-message'

export interface CompactTimelineItem {
  eventId: string
  runId: string
  kind: 'thought' | 'operation' | 'approval' | 'file_patch' | 'retrieval' | 'error' | 'status'
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  endedAt?: number
  durationMs?: number
  summary?: string
  refId?: string
}

export interface AgentToolCallProjection {
  callId: string
  stepId: string
  tool: AgentToolName
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  endedAt?: number
  durationMs?: number
  uiSummary?: string
  modelContext?: ToolResultModelContext
  error?: {
    code: string
    message: string
    technicalDetail?: string
    recoverable: boolean
  }
}

export interface AgentApprovalProjection {
  approvalId: string
  artifactId: string
  callId: string
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'
  deadlineAt?: number
  applied?: boolean
  reason?: string
}

export interface AgentRetrievalProjection {
  retrievalId: string
  callId: string
  sourceIds: string[]
  sourceCount: number
  durationMs: number
}

export interface AgentUsageProjection {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  latencyMs: number
  costUsd: number
  hasEstimatedCost: boolean
  operationIds: string[]
}

export interface AgentEventIndexes {
  toolCalls: Record<string, AgentToolCallProjection>
  approvals: Record<string, AgentApprovalProjection>
  retrievals: Record<string, AgentRetrievalProjection>
  artifactIds: string[]
  usage: AgentUsageProjection
}

export interface EventSnapshot {
  version: number
  runId: string
  throughSequence: number
  eventLogPrefixHash: string
  state: AgentState
  compactTimeline: CompactTimelineItem[]
  indexes: AgentEventIndexes
}

const orderedEvents = (events: AgentEvent[]) => [...events].sort((a, b) => a.sequence - b.sequence)
const unique = <T>(values: T[]) => Array.from(new Set(values))

export const foldAgentState = (events: AgentEvent[]): AgentState => {
  const state: AgentState = {
    status: 'running',
    currentStep: '准备运行',
    completedSteps: [],
  }

  for (const event of orderedEvents(events)) {
    switch (event.type) {
      case 'agent_started':
        state.status = 'running'
        state.currentStep = 'Agent 已启动'
        break
      case 'thought_summary':
        state.currentStep = event.payload.stepId
        break
      case 'tool_call_requested':
        state.status = 'running'
        state.currentStep = event.payload.stepId
        break
      case 'tool_result_recorded':
        state.currentStep = event.payload.stepId
        state.completedSteps = unique([...state.completedSteps, event.payload.stepId])
        break
      case 'approval_required':
        state.status = 'waiting_approval'
        state.pendingApproval = event.payload.approvalId
        state.currentStep = `approval:${event.payload.approvalId}`
        break
      case 'approval_inherited':
        state.status = 'waiting_approval'
        state.pendingApproval = event.payload.approvalId
        state.currentStep = `approval:${event.payload.approvalId}`
        break
      case 'approval_resolved':
        if (state.pendingApproval === event.payload.approvalId) delete state.pendingApproval
        state.status = event.payload.status === 'cancelled' ? 'cancelled' : 'running'
        state.currentStep = `approval:${event.payload.status}`
        break
      case 'file_patch_applied':
        state.currentStep = `patch:${event.payload.path}`
        break
      case 'file_patch_conflict':
      case 'file_patch_failed':
        state.currentStep = `patch:${event.payload.path}`
        break
      case 'run_completed':
        state.status = 'completed'
        state.currentStep = event.payload.completedStep || '已完成'
        delete state.pendingApproval
        break
      case 'run_failed':
      case 'recovery_failed':
        state.status = 'failed'
        state.currentStep = event.payload.message
        delete state.pendingApproval
        break
      case 'run_cancelled':
        state.status = 'cancelled'
        state.currentStep = event.payload.reason
        delete state.pendingApproval
        break
      case 'run_interrupted':
        state.status = 'failed'
        state.currentStep = '运行已中断'
        break
      case 'continuation_created':
        state.status = 'running'
        state.currentStep = '正在恢复执行'
        break
      default:
        break
    }
  }
  return state
}

export const projectToolCalls = (events: AgentEvent[]): Record<string, AgentToolCallProjection> => {
  const calls: Record<string, AgentToolCallProjection> = {}
  for (const event of orderedEvents(events)) {
    if (event.type === 'tool_call_requested') {
      calls[event.payload.callId] = {
        callId: event.payload.callId,
        stepId: event.payload.stepId,
        tool: event.payload.tool,
        status: 'running',
        startedAt: event.payload.startedAt,
      }
    } else if (event.type === 'tool_result_recorded') {
      const existing = calls[event.payload.callId]
      calls[event.payload.callId] = {
        callId: event.payload.callId,
        stepId: event.payload.stepId,
        tool: event.payload.tool,
        status: event.payload.status,
        startedAt: existing?.startedAt ?? Math.max(0, event.timestamp - event.payload.durationMs),
        endedAt: event.timestamp,
        durationMs: event.payload.durationMs,
        uiSummary: event.payload.uiSummary,
        modelContext: event.payload.modelContext,
        error: event.payload.error,
      }
    }
  }
  return calls
}

export const projectApprovals = (events: AgentEvent[]): Record<string, AgentApprovalProjection> => {
  const approvals: Record<string, AgentApprovalProjection> = {}
  for (const event of orderedEvents(events)) {
    if (event.type === 'approval_required') {
      approvals[event.payload.approvalId] = {
        approvalId: event.payload.approvalId,
        artifactId: event.payload.artifactId,
        callId: event.payload.callId,
        status: 'pending',
        deadlineAt: event.payload.deadlineAt,
      }
    } else if (event.type === 'approval_inherited') {
      const existing = approvals[event.payload.approvalId]
      approvals[event.payload.approvalId] = {
        approvalId: event.payload.approvalId,
        artifactId: event.payload.artifactId,
        callId: event.payload.callId,
        status: existing?.status ?? 'pending',
        deadlineAt: existing?.deadlineAt,
      }
    } else if (event.type === 'approval_resolved') {
      const existing = approvals[event.payload.approvalId]
      approvals[event.payload.approvalId] = {
        approvalId: event.payload.approvalId,
        artifactId: event.payload.artifactId,
        callId: event.payload.callId,
        status: event.payload.status,
        deadlineAt: existing?.deadlineAt,
        applied: event.payload.applied,
        reason: event.payload.reason,
      }
    }
  }
  return approvals
}

export const projectRetrievals = (events: AgentEvent[]): Record<string, AgentRetrievalProjection> => {
  const retrievals: Record<string, AgentRetrievalProjection> = {}
  for (const event of orderedEvents(events)) {
    if (event.type !== 'retrieval_completed') continue
    retrievals[event.payload.retrievalId] = {
      retrievalId: event.payload.retrievalId,
      callId: event.payload.callId,
      sourceIds: [...event.payload.sourceIds],
      sourceCount: event.payload.sourceCount,
      durationMs: event.payload.durationMs,
    }
  }
  return retrievals
}

const addUsage = (usage: AgentUsageProjection, payload: UsageUpdatePayload) => {
  if (usage.operationIds.includes(payload.operationId)) return usage
  return {
    inputTokens: usage.inputTokens + (payload.inputTokens || 0),
    outputTokens: usage.outputTokens + (payload.outputTokens || 0),
    totalTokens: usage.totalTokens + (payload.totalTokens ?? (payload.inputTokens || 0) + (payload.outputTokens || 0)),
    latencyMs: usage.latencyMs + Math.max(0, payload.latencyMs),
    costUsd: usage.costUsd + (payload.cost?.amount || 0),
    hasEstimatedCost: usage.hasEstimatedCost || Boolean(payload.cost?.estimated),
    operationIds: [...usage.operationIds, payload.operationId],
  }
}

export const projectUsage = (events: AgentEvent[]): AgentUsageProjection => {
  let usage: AgentUsageProjection = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
    costUsd: 0,
    hasEstimatedCost: false,
    operationIds: [],
  }
  for (const event of orderedEvents(events)) {
    if (event.type === 'usage_updated') usage = addUsage(usage, event.payload)
  }
  return usage
}

export const projectEventIndexes = (events: AgentEvent[]): AgentEventIndexes => {
  const artifactIds: string[] = []
  for (const event of orderedEvents(events)) {
    if (event.type === 'artifact_created') artifactIds.push(event.payload.artifactId)
  }
  return {
    toolCalls: projectToolCalls(events),
    approvals: projectApprovals(events),
    retrievals: projectRetrievals(events),
    artifactIds: unique(artifactIds),
    usage: projectUsage(events),
  }
}

export const projectCompactTimeline = (events: AgentEvent[]): CompactTimelineItem[] => {
  const calls = projectToolCalls(events)
  const items: CompactTimelineItem[] = []
  for (const event of orderedEvents(events)) {
    switch (event.type) {
      case 'thought_summary':
        items.push({ eventId: event.id, runId: event.runId, kind: 'thought', title: '思考', status: 'completed', startedAt: event.timestamp, endedAt: event.timestamp, summary: event.payload.summary })
        break
      case 'tool_call_requested': {
        const call = calls[event.payload.callId]
        items.push({
          eventId: event.id,
          runId: event.runId,
          kind: 'operation',
          title: `调用 ${event.payload.tool}`,
          status: call?.status ?? 'running',
          startedAt: event.payload.startedAt,
          endedAt: call?.endedAt,
          durationMs: call?.durationMs,
          summary: call?.uiSummary,
          refId: event.payload.callId,
        })
        break
      }
      case 'approval_required':
        items.push({ eventId: event.id, runId: event.runId, kind: 'approval', title: '等待审批', status: 'pending', startedAt: event.timestamp, refId: event.payload.approvalId })
        break
      case 'retrieval_completed':
        items.push({ eventId: event.id, runId: event.runId, kind: 'retrieval', title: '检索来源', status: 'completed', startedAt: Math.max(0, event.timestamp - event.payload.durationMs), endedAt: event.timestamp, durationMs: event.payload.durationMs, summary: `找到 ${event.payload.sourceCount} 个来源`, refId: event.payload.retrievalId })
        break
      case 'file_patch_applied':
        items.push({ eventId: event.id, runId: event.runId, kind: 'file_patch', title: event.payload.path, status: 'completed', startedAt: event.timestamp, endedAt: event.timestamp, summary: '修改已安全写入', refId: event.payload.artifactId })
        break
      case 'file_patch_conflict':
      case 'file_patch_failed':
        items.push({ eventId: event.id, runId: event.runId, kind: 'file_patch', title: event.payload.path, status: 'failed', startedAt: event.timestamp, endedAt: event.timestamp, summary: event.type === 'file_patch_conflict' ? '文件版本已变化，未应用修改' : event.payload.message, refId: event.payload.artifactId })
        break
      case 'run_completed':
        items.push({ eventId: event.id, runId: event.runId, kind: 'status', title: '运行完成', status: 'completed', startedAt: event.timestamp, endedAt: event.timestamp })
        break
      case 'run_failed':
      case 'recovery_failed':
        items.push({ eventId: event.id, runId: event.runId, kind: 'error', title: '运行失败', status: 'failed', startedAt: event.timestamp, endedAt: event.timestamp, summary: event.payload.message })
        break
      case 'run_cancelled':
        items.push({ eventId: event.id, runId: event.runId, kind: 'status', title: '运行已取消', status: 'cancelled', startedAt: event.timestamp, endedAt: event.timestamp, summary: event.payload.reason })
        break
      default:
        break
    }
  }
  return items
}

export const createEventSnapshot = (
  runId: string,
  events: AgentEvent[],
  eventLogPrefixHash: string,
  version = 1,
): EventSnapshot => {
  const ordered = orderedEvents(events)
  return {
    version,
    runId,
    throughSequence: ordered.at(-1)?.sequence ?? 0,
    eventLogPrefixHash,
    state: foldAgentState(ordered),
    compactTimeline: projectCompactTimeline(ordered),
    indexes: projectEventIndexes(ordered),
  }
}
