import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

const setup = () => {
  const store = vue.reactive({ activeTab: { kind: 'file', id: 'a', relativePath: 'a.md' }, activeFileContent: '# A', outlineExpandedHeadingIds: {}, setOutlineExpandedHeadingIds: vi.fn() })
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: (_event: { data: object }) => {} }
  vi.stubGlobal('Worker', class { constructor() { return worker } })
  const watchers: Array<() => void> = []
  const source = readFileSync(new URL('../OutlinePanel.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0].replace(/import\.meta\.url/g, JSON.stringify(import.meta.url))
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const require = (id: string) => id === 'vue' ? { ...vue, onBeforeUnmount: vi.fn(), watch: (get: () => unknown, callback: (value: unknown) => void) => { watchers.push(() => callback(get())); callback(get()) } }
    : id.includes('stores/workspace') ? { useWorkspaceStore: () => store } : {}
  const api = new Function('require', 'exports', `${code}\nreturn { toggleHeading, visibleRows };`)(require, {})
  return { store, worker, api, watchers }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('outline panel expansion transport', () => {
  it('sends content only for source changes and ignores superseded replies', () => {
    const h = setup()
    const initial = h.worker.postMessage.mock.lastCall![0]
    expect(initial.content).toBe('# A')
    h.api.toggleHeading('heading')
    const toggle = h.worker.postMessage.mock.lastCall![0]
    expect(toggle).not.toHaveProperty('content')
    expect(toggle.contentRevision).toBe(initial.contentRevision)
    expect(h.store.setOutlineExpandedHeadingIds).toHaveBeenCalledWith('a', ['heading'])
    h.worker.onmessage({ data: { requestId: initial.requestId, success: true, items: [], visibleRows: ['stale'], expandedIds: [], knownIds: [] } })
    expect(h.api.visibleRows.value).toEqual([])
    h.store.activeFileContent = '# Updated'
    h.watchers.forEach(fn => fn())
    const update = h.worker.postMessage.mock.lastCall![0]
    expect(update.content).toBe('# Updated')
    expect(update.contentRevision).not.toBe(initial.contentRevision)
    h.api.toggleHeading('heading')
    expect(h.worker.postMessage.mock.lastCall![0].contentRevision).toBe(update.contentRevision)
  })
})
