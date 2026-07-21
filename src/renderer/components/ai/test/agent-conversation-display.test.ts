import { describe, expect, it } from 'vitest'
import {
  buildSideBySideDiffRows,
  countUnifiedDiffChanges,
  formatAgentArgumentsPreview,
  partitionAgentConversationEvents,
} from '../agentConversationDisplay'

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
