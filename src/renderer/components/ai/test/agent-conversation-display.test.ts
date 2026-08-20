import { describe, expect, it } from 'vitest'
import {
  buildSideBySideDiffRows,
  countUnifiedDiffChanges,
  formatAgentArgumentsPreview,
  getSyncedDiffScrollLeft,
  partitionAgentConversationEvents,
  shouldUseInlineDiff,
} from '../agentConversationDisplay'
import { projectAgentRunView } from '@/renderer/stores/agent-event-view'

describe('agent conversation display helpers', () => {
  it('redacts sensitive argument keys and bounds nested previews', () => {
    const preview = formatAgentArgumentsPreview({
      path: 'docs/guide.md',
      token: 'secret-token',
      nested: { authorization: 'Bearer secret', keep: 'visible' },
    })

    expect(preview).toContain('docs/guide.md')
    expect(preview).toContain('visible')
    expect(preview).toContain('[已脱敏]')
    expect(preview).not.toContain('secret-token')
    expect(preview).not.toContain('Bearer secret')
  })

  it('keeps truncated argument previews valid JSON within the persistence limit', () => {
    const preview = formatAgentArgumentsPreview(Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field${index}`, `value-${index}-${'x'.repeat(800)}`]),
    ))

    expect(preview.length).toBeLessThanOrEqual(4_000)
    expect(() => JSON.parse(preview)).not.toThrow()
    expect(JSON.parse(preview)).toMatchObject({ truncated: true })
  })

  it('counts additions and deletions without counting diff headers', () => {
    const diff = [
      '--- a/note.md',
      '+++ b/note.md',
      '@@ -1,2 +1,3 @@',
      ' context',
      '-before',
      '+after',
      '+added',
    ].join('\n')

    expect(countUnifiedDiffChanges(diff)).toEqual({ additions: 2, deletions: 1 })
  })

  it('keeps one compact file-review record and reflects its resolved status', () => {
    const base = { taskId: 'task-1', runId: 'run-1' }
    const events = [
      { ...base, id: 'call', sequence: 1, timestamp: 1, family: 'execution', type: 'tool_call_requested', payload: { stepId: 'step-1', callId: 'call-1', tool: 'file_patch', argumentsPreview: { path: 'notes/a.md' }, argumentsDigest: 'digest', startedAt: 1 } },
      { ...base, id: 'artifact', sequence: 2, timestamp: 2, family: 'artifact', type: 'artifact_created', payload: { artifactId: 'artifact-1', callId: 'call-1', kind: 'file_patch', path: 'notes/a.md', beforeHash: 'before', afterHash: 'after', operation: 'update', diff: '-old\n+new', additions: 1, deletions: 1, createdAt: 2, expiresAt: 10_000 } },
      { ...base, id: 'required', sequence: 3, timestamp: 3, family: 'artifact', type: 'approval_required', payload: { approvalId: 'approval-1', callId: 'call-1', artifactId: 'artifact-1', deadlineAt: 10_000 } },
      { ...base, id: 'resolved', sequence: 4, timestamp: 4, family: 'artifact', type: 'approval_resolved', payload: { approvalId: 'approval-1', callId: 'call-1', artifactId: 'artifact-1', status: 'approved', applied: true } },
    ] as any

    const reviews = projectAgentRunView(events, []).displayEvents.filter(event => event.kind === 'file_review')
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({ status: 'approved', fileReview: { approvalId: 'approval-1', path: 'notes/a.md' } })
  })

  it('closes a file_patch operation from its durable artifact when the result transaction is interrupted', () => {
    const base = { taskId: 'task-1', runId: 'run-1' }
    const events = [
      { ...base, id: 'start', sequence: 1, timestamp: 1, family: 'execution', type: 'agent_started', payload: { requestId: 'request-1', inputMessageId: 1, assistantMessageId: 2, modelIdentity: {}, contextVersion: 1 } },
      { ...base, id: 'call', sequence: 2, timestamp: 2, family: 'execution', type: 'tool_call_requested', payload: { stepId: 'step-1', callId: 'call-1', tool: 'file_patch', argumentsPreview: { path: 'notes/a.md' }, argumentsDigest: 'digest', startedAt: 2 } },
      { ...base, id: 'artifact', sequence: 3, timestamp: 3, family: 'artifact', type: 'artifact_created', payload: { artifactId: 'artifact-1', callId: 'call-1', kind: 'file_patch', path: 'notes/a.md', beforeHash: 'before', afterHash: 'after', operation: 'update', diff: '-old\n+new', additions: 1, deletions: 1, createdAt: 3, expiresAt: 10_000 } },
      { ...base, id: 'required', sequence: 4, timestamp: 4, family: 'artifact', type: 'approval_required', payload: { approvalId: 'approval-1', callId: 'call-1', artifactId: 'artifact-1', deadlineAt: 10_000 } },
      { ...base, id: 'failed', sequence: 6, timestamp: 6, family: 'recovery', type: 'run_failed', payload: { code: 'agent_bridge_failed', message: 'Agent 服务暂时不可用', retryable: true } },
    ] as any

    const projected = projectAgentRunView(events, [])
    expect(projected.displayEvents.find(event => event.kind === 'tool_call')).toMatchObject({
      callId: 'call-1',
      status: 'completed',
      content: '文件修改提案已生成，等待审查。',
    })
    expect(projected.displayEvents.find(event => event.kind === 'file_review')).toMatchObject({ status: 'pending_approval' })
    expect(projected.timeline.find(step => step.id === 'step-1')).toMatchObject({ status: 'completed' })
  })

  it('marks an unmatched tool call as interrupted instead of leaving it active after run failure', () => {
    const base = { taskId: 'task-1', runId: 'run-1' }
    const events = [
      { ...base, id: 'start', sequence: 1, timestamp: 1, family: 'execution', type: 'agent_started', payload: { requestId: 'request-1', inputMessageId: 1, assistantMessageId: 2, modelIdentity: {}, contextVersion: 1 } },
      { ...base, id: 'call', sequence: 2, timestamp: 2, family: 'execution', type: 'tool_call_requested', payload: { stepId: 'step-1', callId: 'call-1', tool: 'file_read', argumentsPreview: { path: 'notes/a.md' }, argumentsDigest: 'digest', startedAt: 2 } },
      { ...base, id: 'failed', sequence: 3, timestamp: 3, family: 'recovery', type: 'run_failed', payload: { code: 'agent_bridge_failed', message: 'Agent 服务暂时不可用', retryable: true } },
    ] as any

    const projected = projectAgentRunView(events, [])
    expect(projected.displayEvents.find(event => event.kind === 'tool_call')).toMatchObject({
      callId: 'call-1',
      status: 'error',
      content: '运行已中断，未收到工具结果。',
    })
    expect(projected.timeline.find(step => step.id === 'step-1')).toMatchObject({ status: 'error' })
  })

  it('projects a provider-level thought once per tool batch for legacy ledgers', () => {
    const base = { taskId: 'task-1', runId: 'run-1' }
    const thought = (id: string, sequence: number, stepId: string, callId: string) => ({
      ...base, id, sequence, timestamp: sequence, family: 'execution', type: 'thought_summary',
      payload: { stepId, callId, summary: '读取前 7 天的日记。' },
    })
    const call = (id: string, sequence: number, stepId: string, callId: string) => ({
      ...base, id, sequence, timestamp: sequence, family: 'execution', type: 'tool_call_requested',
      payload: { stepId, callId, tool: 'file_read', argumentsPreview: {}, argumentsDigest: id, startedAt: sequence },
    })
    const result = (id: string, sequence: number, stepId: string, callId: string) => ({
      ...base, id, sequence, timestamp: sequence, family: 'execution', type: 'tool_result_recorded',
      payload: { stepId, callId, tool: 'file_read', status: 'completed', durationMs: 1, uiSummary: '完成', modelContext: { facts: [], structuredData: {} } },
    })
    const events = [
      thought('thought-1', 1, 'step-1', 'call-1'),
      call('call-1', 2, 'step-1', 'call-1'),
      thought('thought-2', 3, 'step-2', 'call-2'),
      call('call-2', 4, 'step-2', 'call-2'),
      result('result-1', 5, 'step-1', 'call-1'),
      result('result-2', 6, 'step-2', 'call-2'),
      thought('thought-3', 7, 'step-3', 'call-3'),
      call('call-3', 8, 'step-3', 'call-3'),
    ] as any

    const displayEvents = projectAgentRunView(events, []).displayEvents
    expect(displayEvents.filter(event => event.kind === 'thought').map(event => event.id))
      .toEqual(['thought-1', 'thought-3'])
    expect(displayEvents.filter(event => event.kind === 'tool_call')).toHaveLength(3)
  })

  it('collapses every tool event after the final answer and keeps only the latest call live', () => {
    const events = [
      { id: 'thought-1', order: 1, kind: 'thought', stepId: 'step-1', callId: 'call-1', title: '思考', content: '第一步', status: 'completed', createdAt: 1 },
      { id: 'call-1', order: 2, kind: 'tool_call', stepId: 'step-1', callId: 'call-1', title: '调用 file_read', status: 'completed', createdAt: 2 },
      { id: 'thought-2', order: 3, kind: 'thought', stepId: 'step-2', callId: 'call-2', title: '思考', content: '第二步', status: 'completed', createdAt: 3 },
      { id: 'call-2', order: 4, kind: 'tool_call', stepId: 'step-2', callId: 'call-2', title: '调用 workspace_search', status: 'completed', createdAt: 4 },
      { id: 'thought-3', order: 5, kind: 'thought', stepId: 'step-3', callId: 'call-3', title: '思考', content: '第三步', status: 'completed', createdAt: 5 },
      { id: 'call-3', order: 6, kind: 'tool_call', stepId: 'step-3', callId: 'call-3', title: '调用 rag_search', status: 'active', createdAt: 6 },
    ] as const

    const live = partitionAgentConversationEvents([...events], false)
    expect(live.collapsed.map(event => event.id)).toEqual(['thought-1', 'call-1', 'thought-2', 'call-2'])
    expect(live.visible.map(event => event.id)).toEqual(['thought-3', 'call-3'])

    const completed = partitionAgentConversationEvents([...events], true)
    expect(completed.collapsed).toHaveLength(events.length)
    expect(completed.visible).toEqual([])
  })

  it('switches to an inline diff only when the available view is too narrow', () => {
    expect(shouldUseInlineDiff(759)).toBe(true)
    expect(shouldUseInlineDiff(760)).toBe(false)
    expect(shouldUseInlineDiff(1_200)).toBe(false)
  })

  it('synchronizes horizontal scrolling proportionally across unequal diff panes', () => {
    expect(getSyncedDiffScrollLeft(300, 1_000, 400, 700, 400)).toBe(150)
    expect(getSyncedDiffScrollLeft(800, 1_000, 400, 700, 400)).toBe(300)
    expect(getSyncedDiffScrollLeft(100, 400, 400, 700, 400)).toBe(0)
  })

  it('builds aligned before and after rows from a unified diff', () => {
    const rows = buildSideBySideDiffRows([
      '@@ -4,2 +4,2 @@',
      '-old line',
      '+new line',
      ' unchanged',
    ].join('\n'))

    expect(rows[1]).toMatchObject({ kind: 'deletion', beforeLine: 4, before: 'old line', after: '' })
    expect(rows[2]).toMatchObject({ kind: 'addition', afterLine: 4, before: '', after: 'new line' })
    expect(rows[3]).toMatchObject({ kind: 'context', beforeLine: 5, afterLine: 5, before: 'unchanged', after: 'unchanged' })
  })
})
