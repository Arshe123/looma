import { describe, expect, it } from 'vitest'
import { diffMemoryLines } from '../agent-memory-changes'

describe('confirmed memory change diff', () => {
  it('omits unchanged private context and keeps separate edits', () => {
    expect(diffMemoryLines('secret\n旧\nprivate\n删除\nend', 'secret\n新\nprivate\nend\n新增')).toEqual([
      { type: 'removed', text: '旧' }, { type: 'added', text: '新' },
      { type: 'removed', text: '删除' }, { type: 'added', text: '新增' },
    ])
  })
  it('handles no-op, creation, clearing and empty-line changes', () => {
    expect(diffMemoryLines('相同\n', '相同\n')).toEqual([])
    expect(diffMemoryLines('', '中文\n🙂')).toEqual([{ type: 'added', text: '中文\n🙂' }])
    expect(diffMemoryLines('中文\n🙂', '')).toEqual([{ type: 'removed', text: '中文\n🙂' }])
    expect(diffMemoryLines('中文', '中文\n')).toEqual([{ type: 'added', text: '' }])
    expect(diffMemoryLines('中文\n', '中文')).toEqual([{ type: 'removed', text: '' }])
  })
  it('retains the entire bounded profile change rather than a generic tool preview', () => {
    const before = '旧'.repeat(16000)
    const after = '新'.repeat(16000)
    expect(diffMemoryLines(before, after)).toEqual([{ type: 'removed', text: before }, { type: 'added', text: after }])
    expect(diffMemoryLines('\n'.repeat(15999), '\n'.repeat(15998))).toEqual([{ type: 'removed', text: '' }])
  })
  it('reports reorderings and repeated lines using a minimal line edit script', () => {
    const inputs = ['', 'a', 'b', 'a\nb', 'b\na', 'a\na\nb', 'b\na\nb', 'a\nb\na', 'a\na\na']
    for (const before of inputs) for (const after of inputs) {
      const a = before ? before.split('\n') : []; const b = after ? after.split('\n') : []
      const lengths = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        lengths[i][j] = a[i - 1] === b[j - 1] ? lengths[i - 1][j - 1] + 1 : Math.max(lengths[i - 1][j], lengths[i][j - 1])
      }
      const changes = diffMemoryLines(before, after)
      const count = changes.reduce((sum, change) => sum + change.text.split('\n').length, 0)
      expect(count, `${before} -> ${after}`).toBe(a.length + b.length - 2 * lengths[a.length][b.length])
    }
  })
})
