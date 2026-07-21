import { describe, expect, it } from 'vitest'
import {
  buildSideBySideDiffRows,
  countUnifiedDiffChanges,
  formatAgentArgumentsPreview,
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
