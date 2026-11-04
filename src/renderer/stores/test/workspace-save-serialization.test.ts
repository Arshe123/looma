import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

const textState = (content: string) => ({
  content, loadedContent: content, isSaving: false, saveError: '',
  isPartial: false, isLoading: false, isLoadingMore: false,
  nextOffset: content.length, totalBytes: content.length, loadRequestId: 1, useChunkedPreview: false,
})
const setup = (writeMarkdown: ReturnType<typeof vi.fn>, showMessageBox = vi.fn().mockResolvedValue({ response: 1 })) => {
  (window as any).electronAPI = {
    file: { writeMarkdown }, app: { showMessageBox },
    draftRecovery: { save: vi.fn().mockResolvedValue({ success: true }), remove: vi.fn().mockResolvedValue({ success: true }) },
  }
  const store = useWorkspaceStore()
  store.workspaces = [{ id: 'w', name: 'Notes', path: '/notes', createdAt: 1, lastOpenedAt: 1 }]
  store.activeWorkspaceId = 'w'
  store.activeFileRelativePath = 'note.md'
  store.activeFilePath = '/notes/note.md'
  store.openedTextFileContents['note.md'] = textState('saved')
  return store
}
const barrier = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  ;(globalThis as any).window = globalThis.window || globalThis
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('workspace per-file save serialization', () => {
  it('waits for the preceding save and takes the newest live content and disk baseline', async () => {
    const entered = barrier(), release = barrier()
    let disk = 'saved'
    const write = vi.fn(async (_file: string, content: string, expected: string) => {
      expect(expected).toBe(disk)
      if (content === 'first') { entered.resolve(); await release.promise }
      disk = content
      return { success: true }
    })
    const store = setup(write)
    store.setActiveFileContent('first', 'note.md')
    const first = store.saveActiveFileContent('first', 'note.md')
    await entered.promise
    const second = store.saveActiveFileContent('second', 'note.md')
    store.setActiveFileContent('third', 'note.md')
    expect(write).toHaveBeenCalledTimes(1)
    release.resolve()
    expect((await first).success).toBe(true)
    expect((await second).success).toBe(true)
    expect(write.mock.calls.map(call => call.slice(1))).toEqual([['first', 'saved'], ['third', 'first']])
    expect(disk).toBe('third')
    expect(store.openedTextFileContents['note.md']).toMatchObject({ content: 'third', loadedContent: 'third', isSaving: false, saveError: '' })
  })

  it('retains genuine external-change protection instead of retrying with a stale baseline', async () => {
    const entered = barrier(), release = barrier()
    const write = vi.fn(async () => {
      entered.resolve(); await release.promise
      return { success: false, errorCode: 'FILE_CHANGED_ON_DISK', error: 'external change' }
    })
    const confirm = vi.fn().mockResolvedValue({ response: 1 })
    const store = setup(write, confirm)
    store.setActiveFileContent('first', 'note.md')
    const first = store.saveActiveFileContent('first', 'note.md')
    await entered.promise
    const second = store.saveActiveFileContent('second', 'note.md')
    release.resolve()
    expect((await first).success).toBe(false)
    expect((await second).success).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledOnce()
    expect(store.openedTextFileContents['note.md']).toMatchObject({ content: 'second', loadedContent: 'saved', recoveryConflict: true })
  })

  it('does not serialize unrelated files behind a slow note save', async () => {
    const entered = barrier(), release = barrier()
    const write = vi.fn(async (_file: string, content: string) => {
      if (content === 'slow') { entered.resolve(); await release.promise }
      return { success: true }
    })
    const store = setup(write)
    store.openedTextFileContents['other.md'] = textState('other saved')
    const slow = store.saveActiveFileContent('slow', 'note.md')
    await entered.promise
    expect((await store.saveActiveFileContent('other draft', 'other.md')).success).toBe(true)
    expect(store.openedTextFileContents['other.md'].loadedContent).toBe('other draft')
    release.resolve()
    await slow
  })

  it('cancels a queued save when the file was closed and reopened during the preceding write', async () => {
    const entered = barrier(), release = barrier()
    const write = vi.fn(async () => { entered.resolve(); await release.promise; return { success: true } })
    const store = setup(write)
    const first = store.saveActiveFileContent('first', 'note.md')
    await entered.promise
    const queued = store.saveActiveFileContent('second', 'note.md')
    store.openedTextFileContents['note.md'] = { ...textState('reopened'), loadRequestId: 2 }
    release.resolve()
    await first
    expect(await queued).toEqual({ success: false, error: '笔记已切换或关闭，已取消排队的保存。' })
    expect(write).toHaveBeenCalledTimes(1)
    expect(store.openedTextFileContents['note.md']).toEqual({ ...textState('reopened'), loadRequestId: 2 })
  })
})
