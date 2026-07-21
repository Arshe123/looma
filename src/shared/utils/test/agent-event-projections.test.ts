import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../types/agent-events'
import { createEventSnapshot, foldAgentState, projectCompactTimeline, projectEventIndexes } from '../agent-event-projections'

const base = { taskId: 'task_1', runId: 'run_1' }
const events: AgentEvent[] = [
  { ...base, id: 'evt_1', sequence: 1, timestamp: 10, family: 'execution', type: 'agent_started', payload: { requestId: 'req_1', inputMessageId: 'msg_user', assistantMessageId: 'msg_answer', modelIdentity: { provider: 'openai', model: 'gpt-test' }, contextVersion: 1 } },
  { ...base, id: 'evt_2', sequence: 2, timestamp: 20, family: 'execution', type: 'thought_summary', payload: { stepId: 'step_1', callId: 'call_1', summary: '先读取配置文件。' } },
  { ...base, id: 'evt_3', sequence: 3, timestamp: 30, family: 'execution', type: 'tool_call_requested', payload: { stepId: 'step_1', callId: 'call_1', tool: 'file_read', argumentsPreview: { path: 'docs/config.md' }, argumentsDigest: 'digest_1', startedAt: 30 } },
  { ...base, id: 'evt_4', sequence: 4, timestamp: 80, family: 'execution', type: 'tool_result_recorded', payload: { stepId: 'step_1', callId: 'call_1', tool: 'file_read', status: 'completed', durationMs: 50, uiSummary: '已读取配置文件', modelContext: { facts: ['配置文件存在'], structuredData: { path: 'docs/config.md' } } } },
  { ...base, id: 'evt_5', sequence: 5, timestamp: 90, family: 'execution', type: 'retrieval_completed', payload: { retrievalId: 'ret_1', callId: 'call_2', tool: 'rag_search', queryDigest: 'query_1', sourceIds: ['src_1', 'src_2'], sourceCount: 2, durationMs: 10 } },
  { ...base, id: 'evt_6', sequence: 6, timestamp: 100, family: 'execution', type: 'usage_updated', payload: { operationId: 'op_1', phase: 'decision', provider: 'openai', model: 'gpt-test', inputTokens: 10, outputTokens: 5, totalTokens: 15, latencyMs: 70, cost: { amount: 0.01, currency: 'USD', estimated: false } } },
  { ...base, id: 'evt_7', sequence: 7, timestamp: 110, family: 'execution', type: 'usage_updated', payload: { operationId: 'op_1', phase: 'decision', provider: 'openai', model: 'gpt-test', inputTokens: 10, outputTokens: 5, totalTokens: 15, latencyMs: 70, cost: { amount: 0.01, currency: 'USD', estimated: false } } },
  { ...base, id: 'evt_8', sequence: 8, timestamp: 120, family: 'execution', type: 'run_completed', payload: { answerMessageId: 'msg_answer', completedStep: 'final' } },
]

describe('Agent event projections', () => {
  it('folds AgentState only from events', () => {
    expect(foldAgentState(events)).toEqual({
      status: 'completed',
      currentStep: 'final',
      completedSteps: ['step_1'],
    })
  })

  it('keeps UI summary and model context as separate tool projections', () => {
    const call = projectEventIndexes(events).toolCalls.call_1
    expect(call.uiSummary).toBe('已读取配置文件')
    expect(call.modelContext).toEqual({
      facts: ['配置文件存在'],
      structuredData: { path: 'docs/config.md' },
    })
    expect(JSON.stringify(call.modelContext)).not.toContain(call.uiSummary)
  })

  it('groups sources by retrievalId and deduplicates usage by operationId', () => {
    const indexes = projectEventIndexes(events)
    expect(indexes.retrievals.ret_1).toMatchObject({ sourceIds: ['src_1', 'src_2'], sourceCount: 2 })
    expect(indexes.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15, latencyMs: 70, costUsd: 0.01 })
    expect(indexes.usage.operationIds).toEqual(['op_1'])
  })

  it('creates a disposable snapshot and compact timeline without model context', () => {
    const snapshot = createEventSnapshot('run_1', events, 'hash_1')
    expect(snapshot.throughSequence).toBe(8)
    expect(snapshot.state.status).toBe('completed')
    const timeline = projectCompactTimeline(events)
    expect(timeline.find(item => item.refId === 'call_1')).toMatchObject({ title: '调用 file_read', summary: '已读取配置文件', durationMs: 50 })
    expect(JSON.stringify(timeline)).not.toContain('配置文件存在')
    expect(JSON.stringify(timeline)).not.toContain('docs/config.md')
  })
})
