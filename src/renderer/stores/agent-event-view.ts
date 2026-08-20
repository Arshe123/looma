import type { AgentEvent, AgentSource } from '../../shared/types/agent-events'
import { foldAgentState, projectEventIndexes } from '../../shared/utils/agent-event-projections'
import type { AgentConversationDisplayEvent, AgentConversationDisplayEventStatus } from '../components/ai/agentConversationDisplay'
import type { AiAssistantTimelineOutput, AiAssistantTimelineStep } from './workspace-types'

export interface ProjectedAgentApproval {
  approvalId: string
  stepId: string
  path: string
  operation: 'create' | 'update'
  diff: string
  requestedAt: string
  deadlineAt: string
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'error'
  error?: string
}

const ordered = (events: AgentEvent[]) => [...events].sort((a, b) => a.sequence - b.sequence)
const jsonPreview = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2).slice(0, 4_000)
  } catch {
    return '{}'
  }
}

const approvalDisplayStatus = (
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled',
  applied?: boolean,
): AgentConversationDisplayEventStatus => {
  if (status === 'pending') return 'pending_approval'
  if (status === 'approved') return applied ? 'approved' : 'error'
  return status
}

export const isArtifactBackedFilePatchBridgeInterruption = (events: AgentEvent[]) => {
  const orderedEvents = ordered(events)
  const bridgeFailure = [...orderedEvents].reverse().find(event => event.type === 'run_failed')
  if (bridgeFailure?.type !== 'run_failed' || bridgeFailure.payload.code !== 'agent_bridge_failed') return false
  const indexes = projectEventIndexes(events)
  const artifactCallIds = new Set(events.flatMap(event => event.type === 'artifact_created' ? [event.payload.callId] : []))
  const toolByCallId = new Map(events.flatMap(event => event.type === 'tool_call_requested'
    ? [[event.payload.callId, event.payload.tool] as const]
    : []))
  const unfinishedCallIds = Object.values(indexes.toolCalls)
    .filter(call => call.status === 'running')
    .map(call => call.callId)
  return unfinishedCallIds.length > 0 && unfinishedCallIds.every(callId => (
    toolByCallId.get(callId) === 'file_patch' && artifactCallIds.has(callId)
  ))
}

export const projectAgentApprovals = (events: AgentEvent[]): ProjectedAgentApproval[] => {
  const indexes = projectEventIndexes(events)
  const artifacts = new Map<string, Extract<AgentEvent, { type: 'artifact_created' }>['payload']>()
  const stepByCallId = new Map<string, string>()
  for (const event of ordered(events)) {
    if (event.type === 'artifact_created') artifacts.set(event.payload.artifactId, event.payload)
    if (event.type === 'tool_call_requested') stepByCallId.set(event.payload.callId, event.payload.stepId)
  }
  return Object.values(indexes.approvals).flatMap((approval) => {
    const artifact = artifacts.get(approval.artifactId)
    if (!artifact) return []
    return [{
      approvalId: approval.approvalId,
      stepId: stepByCallId.get(approval.callId) || '',
      path: artifact.path,
      operation: artifact.operation,
      diff: artifact.diff,
      requestedAt: new Date(artifact.createdAt).toISOString(),
      deadlineAt: new Date(approval.deadlineAt ?? artifact.expiresAt).toISOString(),
      status: approval.status === 'approved' && !approval.applied ? 'error' : approval.status,
      error: approval.reason,
    }]
  })
}

export const projectAgentDisplayEvents = (events: AgentEvent[]): AgentConversationDisplayEvent[] => {
  const indexes = projectEventIndexes(events)
  const state = foldAgentState(events)
  const approvals = indexes.approvals
  const approvalByArtifact = new Map(Object.values(approvals).map((approval) => [approval.artifactId, approval]))
  const artifactCallIds = new Set(events.flatMap(event => event.type === 'artifact_created' ? [event.payload.callId] : []))
  const result: AgentConversationDisplayEvent[] = []
  const batchThoughtSummaries = new Set<string>()

  for (const event of ordered(events)) {
    // Tool calls from one model decision are recorded before their results. Old
    // ledgers may contain the same provider-level summary once per call, so use
    // the first result as the batch boundary while projecting historical data.
    if (event.type === 'tool_result_recorded') batchThoughtSummaries.clear()
    if (event.type === 'thought_summary') {
      const summary = event.payload.summary.trim()
      if (!summary || batchThoughtSummaries.has(summary)) continue
      batchThoughtSummaries.add(summary)
      result.push({
        id: event.id,
        order: event.sequence,
        kind: 'thought',
        stepId: event.payload.stepId,
        callId: event.payload.callId,
        title: '思考摘要',
        content: summary,
        status: 'completed',
        createdAt: event.timestamp,
      })
      continue
    }
    if (event.type === 'tool_call_requested') {
      const call = indexes.toolCalls[event.payload.callId]
      const patchProposalCreated = event.payload.tool === 'file_patch' && artifactCallIds.has(event.payload.callId)
      const interrupted = call?.status === 'running' && ['failed', 'cancelled'].includes(state.status)
      result.push({
        id: event.id,
        order: event.sequence,
        kind: 'tool_call',
        stepId: event.payload.stepId,
        callId: event.payload.callId,
        title: `调用 ${event.payload.tool}`,
        content: patchProposalCreated
          ? '文件修改提案已生成，等待审查。'
          : call?.status === 'completed'
          ? '工具调用已完成。'
          : call?.status === 'failed'
            ? '工具调用失败。'
            : interrupted
              ? '运行已中断，未收到工具结果。'
            : event.payload.tool === 'file_patch'
              ? '正在生成文件修改提案。'
              : `正在执行工具 ${event.payload.tool}。`,
        tool: event.payload.tool,
        argumentsPreview: jsonPreview(event.payload.argumentsPreview),
        durationMs: call?.durationMs,
        status: patchProposalCreated || call?.status === 'completed'
          ? 'completed'
          : call?.status === 'failed' || interrupted
            ? 'error'
            : 'active',
        createdAt: event.timestamp,
      })
      continue
    }
    if (event.type === 'artifact_created') {
      const approval = approvalByArtifact.get(event.payload.artifactId)
      result.push({
        id: event.id,
        order: event.sequence,
        kind: 'file_review',
        stepId: indexes.toolCalls[event.payload.callId]?.stepId || '',
        callId: event.payload.callId,
        title: event.payload.path,
        content: event.payload.operation === 'create' ? '新建文件提案' : '文件修改提案',
        status: approval ? approvalDisplayStatus(approval.status, approval.applied) : 'pending_approval',
        createdAt: event.timestamp,
        fileReview: {
          approvalId: approval?.approvalId || '',
          path: event.payload.path,
          operation: event.payload.operation,
          diff: event.payload.diff,
          additions: event.payload.additions,
          deletions: event.payload.deletions,
        },
      })
    }
  }
  return result
}

export const projectAgentTimeline = (events: AgentEvent[], sources: AgentSource[]): AiAssistantTimelineStep[] => {
  const indexes = projectEventIndexes(events)
  const state = foldAgentState(events)
  const cancelledAt = ordered(events).find((event) => event.type === 'run_cancelled')?.timestamp
  const failedAt = ordered(events).find((event) => event.type === 'run_failed')?.timestamp
  const artifactCallIds = new Set(events.flatMap(event => event.type === 'artifact_created' ? [event.payload.callId] : []))
  const steps: AiAssistantTimelineStep[] = []
  const started = ordered(events).find((event) => event.type === 'agent_started')
  if (started) {
    steps.push({ id: 'agent-start', title: '启动 Agent', detail: 'Agent 已启动。', status: 'completed', startedAt: started.timestamp, endedAt: started.timestamp, outputs: [] })
  }
  for (const event of ordered(events)) {
    if (event.type !== 'tool_call_requested') continue
    const call = indexes.toolCalls[event.payload.callId]
    const failed = call?.status === 'failed'
    const cancelled = state.status === 'cancelled' && call?.status === 'running'
    const interrupted = state.status === 'failed' && call?.status === 'running'
    const patchProposalCreated = event.payload.tool === 'file_patch' && artifactCallIds.has(event.payload.callId)
    const outputs: AiAssistantTimelineOutput[] = [{ id: `${event.id}-arguments`, type: 'json', title: '调用参数', content: jsonPreview(event.payload.argumentsPreview) }]
    if (call?.uiSummary) outputs.push({
      id: `${event.id}-result`,
      type: failed ? 'error' : 'text',
      title: failed ? '错误' : '结果摘要',
      content: call.uiSummary,
      technicalDetail: call.error?.technicalDetail,
    })
    steps.push({
      id: event.payload.stepId,
      title: `调用 ${event.payload.tool}`,
      detail: patchProposalCreated
        ? '文件修改提案已生成，等待审查。'
        : cancelled
          ? '运行已取消。'
          : interrupted
            ? '运行已中断，未收到工具结果。'
            : call?.uiSummary,
      status: patchProposalCreated || cancelled
        ? 'completed'
        : failed || interrupted
          ? 'error'
          : call?.status === 'completed'
            ? 'completed'
            : 'active',
      startedAt: event.payload.startedAt,
      endedAt: patchProposalCreated
        ? ordered(events).find(item => item.type === 'artifact_created' && item.payload.callId === event.payload.callId)?.timestamp
        : cancelled
          ? cancelledAt
          : interrupted
            ? failedAt
            : call?.endedAt,
      outputs,
    })
  }
  if (sources.length) {
    let sourceTimestamp = 0
    for (const event of ordered(events)) {
      if (event.type === 'retrieval_completed') sourceTimestamp = Math.max(sourceTimestamp, event.timestamp)
    }
    steps.push({
      id: 'agent-sources',
      title: '引用来源',
      detail: `保留 ${sources.length} 个来源片段。`,
      status: 'completed',
      startedAt: sourceTimestamp,
      endedAt: sourceTimestamp,
      outputs: sources.map((source) => ({
        id: source.sourceId,
        type: 'source',
        title: source.path,
        path: source.path,
        content: source.snippet,
        metadata: { score: source.score, retrievalId: source.retrievalId, runId: source.runId },
      })),
    })
  }
  return steps
}

export const projectAgentRunView = (events: AgentEvent[], sources: AgentSource[]) => {
  const state = foldAgentState(events)
  const indexes = projectEventIndexes(events)
  return {
    state,
    indexes,
    displayEvents: projectAgentDisplayEvents(events),
    timeline: projectAgentTimeline(events, sources),
    approvals: projectAgentApprovals(events),
    toolCallCount: Object.keys(indexes.toolCalls).length,
    sourceCount: sources.length,
  }
}
