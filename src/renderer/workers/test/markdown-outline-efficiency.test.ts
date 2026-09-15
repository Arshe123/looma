import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as outline from '@/shared/utils/markdown-outline'
import * as tree from '@/shared/utils/outline-tree'

const setup = () => {
  const parse = vi.fn(outline.parseMarkdownOutline)
  const build = vi.fn(tree.buildOutlineTree)
  const worker = { onmessage: (_event: { data: object }) => {}, postMessage: vi.fn() }
  const source = readFileSync(new URL('../markdown-outline.worker.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'self', 'exports', code)((id: string) => id.endsWith('/markdown-outline')
    ? { ...outline, parseMarkdownOutline: parse } : { ...tree, buildOutlineTree: build }, worker, {})
  const send = (data: object) => {
    worker.onmessage({ data })
    return worker.postMessage.mock.lastCall?.[0]
  }
  return { parse, build, send }
}
const initial = { requestId: 1, contentRevision: 1, content: '# Doc\n## Section\n### Child', expandedIds: [], knownIds: [], resetExpansion: true, hasPersistedExpansion: false }

describe('outline worker cached expansion', () => {
  it('flattens the cached tree without reparsing or receiving content', () => {
    const h = setup()
    const first = h.send(initial)
    expect(first.success).toBe(true)
    expect(first.visibleRows).toHaveLength(3)
    const collapsed = h.send({ requestId: 2, contentRevision: 1, expandedIds: [], knownIds: first.knownIds, resetExpansion: false, hasPersistedExpansion: true })
    expect(collapsed.success).toBe(true)
    expect(collapsed.visibleRows).toHaveLength(1)
    expect(h.parse).toHaveBeenCalledTimes(1)
    expect(h.build).toHaveBeenCalledTimes(1)
    const expanded = h.send({ requestId: 3, contentRevision: 1, expandedIds: first.expandedIds, knownIds: first.knownIds, resetExpansion: false, hasPersistedExpansion: true })
    expect(expanded.visibleRows).toEqual(first.visibleRows)
    expect(h.parse).toHaveBeenCalledTimes(1)
  })
  it('honors an explicit collapse even before the content reply supplies known IDs', () => {
    const h = setup()
    h.send(initial)
    const collapsed = h.send({ requestId: 2, contentRevision: 1, expandedIds: [], knownIds: [], resetExpansion: false, hasPersistedExpansion: false })
    expect(collapsed.visibleRows).toHaveLength(1)
    expect(collapsed.expandedIds).toEqual([])
  })
  it('rejects stale expansion revisions and replaces the tree when content changes', () => {
    const h = setup()
    h.send(initial)
    const next = h.send({ ...initial, requestId: 2, contentRevision: 2, content: '# Other' })
    expect(next.items.map((item: { text: string }) => item.text)).toEqual(['Other'])
    const stale = h.send({ ...initial, requestId: 3, content: undefined })
    expect(stale.success).toBe(false)
    expect(h.parse).toHaveBeenCalledTimes(2)
    expect(h.build).toHaveBeenCalledTimes(2)
  })
})
