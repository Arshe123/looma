import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useNoteRelationsStore } from '../note-relations'
import { useKnowledgeGraphViewStore } from '../knowledge-graph-view'

vi.mock('../workspace', async () => ({
  useWorkspaceStore: (await import('pinia')).defineStore('relations-workspace-fixture', {
    state: () => ({
      activeWorkspaceId: 'one' as string | null,
      openedTextFileContents: {} as Record<string, { content: string; isPartial?: boolean; isLoading?: boolean }>,
    }),
    getters: {
      activeWorkspace: state => state.activeWorkspaceId ? { id: state.activeWorkspaceId, path: `/${state.activeWorkspaceId}` } : null,
    },
    actions: { setActiveAuxiliaryPanel: vi.fn() },
  }),
}))
import { useWorkspaceStore } from '../workspace'

const list = vi.fn()
const read = vi.fn()
let store: ReturnType<typeof useNoteRelationsStore>
let listener: (event: { workspaceId: string; relativePath: string; event: string }) => void
const unsubscribe = vi.fn()
beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  list.mockReset().mockResolvedValue({ success: true, data: ['a.md', 'b.md', 'c.md'] })
  read.mockReset().mockImplementation(async (path: string) => ({ success: true, data: path.endsWith('a.md')
    ? '[b](b.md) [again](b.md#L1) [c](c.md) [missing](missing.md) [web](https://example.com)' : path.endsWith('b.md') ? '[a](a.md)' : '# C' }))
  vi.stubGlobal('window', { electronAPI: { fs: { listNotes: list, onEvent: vi.fn(callback => { listener = callback; return unsubscribe }), watchAdd: vi.fn().mockResolvedValue(undefined) }, file: { readMarkdown: read } } })
  store = useNoteRelationsStore()
})
afterEach(() => { store.stop(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('shares one lazy load and counts distinct valid neighboring notes, not citations or missing links', async () => {
  expect(list).not.toHaveBeenCalled()
  expect(store.summary('a.md')).toBeNull()
  await Promise.all([store.ensureLoaded(), store.ensureLoaded()])
  expect(list).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledTimes(3)
  expect(store.summary('a.md')).toEqual({ outgoing: 2, incoming: 1 })
  expect(store.summary('c.md')).toEqual({ outgoing: 0, incoming: 1 })
  expect(store.summary('absent.md')).toBeNull()
  expect(store.graph.edges).toHaveLength(3)
  await store.ensureLoaded()
  expect(list).toHaveBeenCalledTimes(1)
})

it('opens the requested note graph with a fresh request even when the panel already exists', async () => {
  const workspace = useWorkspaceStore()
  const openPanel = vi.spyOn(workspace, 'setActiveAuxiliaryPanel')
  const view = useKnowledgeGraphViewStore().forWorkspace('one')
  view.query = 'old search'
  view.selectedPath = 'b.md'
  await store.open('a.md')
  expect(openPanel).toHaveBeenCalledWith('graph')
  expect(view).toMatchObject({ selectedPath: 'a.md', focused: true, query: '', requestedPath: 'a.md', requestToken: 1 })
  await store.open('a.md')
  expect(view.requestToken).toBe(2)
  expect(list).toHaveBeenCalledTimes(1)
})

it('overlays complete live drafts but never replaces disk citations with partially loaded text', async () => {
  await store.ensureLoaded()
  const workspace = useWorkspaceStore()
  workspace.openedTextFileContents['a.md'] = { content: '[c](c.md)', isPartial: false, isLoading: false } as never
  await nextTick()
  await vi.advanceTimersByTimeAsync(180)
  expect(store.summary('a.md')).toEqual({ outgoing: 1, incoming: 1 })
  expect(store.summary('b.md')).toEqual({ outgoing: 1, incoming: 0 })
  workspace.openedTextFileContents['a.md'].isPartial = true
  await nextTick()
  await vi.advanceTimersByTimeAsync(180)
  expect(store.summary('a.md')).toEqual({ outgoing: 2, incoming: 1 })
  expect(list).toHaveBeenCalledTimes(1)
})

it('rejects old workspace results and clears old summaries immediately on workspace changes', async () => {
  let finish!: (result: { success: boolean; data: string[] }) => void
  list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const old = store.ensureLoaded()
  useWorkspaceStore().activeWorkspaceId = 'two'
  expect(store.summary('a.md')).toBeNull()
  await store.ensureLoaded()
  finish({ success: true, data: ['old.md'] })
  await old
  expect(store.notes.map(note => note.path)).toEqual(['a.md', 'b.md', 'c.md'])
  expect(store.loading).toBe(false)
  expect(store.error).toBe('')
  expect(list.mock.calls.map(call => call[0])).toEqual(['one', 'two'])
})

it('debounces filesystem events and only rereads invalidated notes', async () => {
  await store.ensureLoaded()
  read.mockClear()
  listener({ workspaceId: 'other', relativePath: 'a.md', event: 'change' })
  listener({ workspaceId: 'one', relativePath: 'image.png', event: 'change' })
  listener({ workspaceId: 'one', relativePath: 'a.md', event: 'change' })
  listener({ workspaceId: 'one', relativePath: 'a.md', event: 'change' })
  await vi.advanceTimersByTimeAsync(299)
  expect(list).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(list).toHaveBeenCalledTimes(2)
  expect(read).toHaveBeenCalledTimes(1)
  expect(store.loading).toBe(false)
})

it('reports unavailable summaries on a load error and supports explicit retry', async () => {
  list.mockRejectedValueOnce(new Error('no permission'))
  await store.ensureLoaded()
  expect(store.error).toBe('no permission')
  expect(store.summary('a.md')).toBeNull()
  await store.refresh()
  expect(store.error).toBe('')
  expect(store.summary('a.md')).toEqual({ outgoing: 2, incoming: 1 })
})

it('does not require Electron APIs without an active workspace or an optional filesystem subscription', async () => {
  useWorkspaceStore().activeWorkspaceId = null
  vi.stubGlobal('window', {})
  await store.ensureLoaded()
  expect(store.summary('a.md')).toBeNull()
  expect(list).not.toHaveBeenCalled()
  vi.stubGlobal('window', { electronAPI: { fs: { listNotes: list }, file: { readMarkdown: read } } })
  useWorkspaceStore().activeWorkspaceId = 'one'
  await store.ensureLoaded()
  expect(store.summary('a.md')).toEqual({ outgoing: 2, incoming: 1 })
})

