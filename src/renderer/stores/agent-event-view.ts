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
  const approvals = indexes.approvals
  const approvalByArtifact = new Map(Object.values(approvals).map((approval) => [approval.artifactId, approval]))
  const result: AgentConversationDisplayEvent[] = []

  for (const event of ordered(events)) {
    if (event.type === 'thought_summary') {
      result.push({
        id: event.id,
        order: event.sequence,
        kind: 'thought',
        stepId: event.payload.stepId,
        callId: event.payload.callId,
        title: '思考摘要',
        content: event.payload.summary,
        status: 'completed',
        createdAt: event.timestamp,
      })
      continue
    }
    if (event.type === 'tool_call_requested') {
      const call = indexes.toolCalls[event.payload.callId]
      result.push({
        id: event.id,
        order: event.sequence,
        kind: 'tool_call',
        stepId: event.payload.stepId,
        callId: event.payload.callId,
        title: `调用 ${event.payload.tool}`,
        content: call?.status === 'completed'
          ? '工具调用已完成。'
          : call?.status === 'failed'
            ? '工具调用失败。'
            : event.payload.tool === 'file_patch'
              ? '正在生成文件修改提案。'
              : `正在执行工具 ${event.payload.tool}。`,
        tool: event.payload.tool,
        argumentsPreview: jsonPreview(event.payload.argumentsPreview),
        durationMs: call?.durationMs,
        status: call?.status === 'failed' ? 'error' : call?.status === 'completed' ? 'completed' : 'active',
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
      detail: cancelled ? '运行已取消。' : call?.uiSummary,
      status: cancelled ? 'completed' : failed ? 'error' : call?.status === 'completed' ? 'completed' : 'active',
      startedAt: event.payload.startedAt,
      endedAt: cancelled ? cancelledAt : call?.endedAt,
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
