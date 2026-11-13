import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'
import { showMessageDialog } from '../message-dialog'

vi.mock('../message-dialog', async importOriginal => {
  const actual = await importOriginal<typeof import('../message-dialog')>()
  return { ...actual, showMessageDialog: vi.fn() }
})

const textState = (content: string) => ({
  content, loadedContent: content, isSaving: false, saveError: '',
  isPartial: false, isLoading: false, isLoadingMore: false,
  nextOffset: content.length, totalBytes: content.length, loadRequestId: 1, useChunkedPreview: false,
})
const setup = (writeMarkdown: ReturnType<typeof vi.fn>, showMessageBox = vi.fn().mockResolvedValue({ response: 1 })) => {
  vi.mocked(showMessageDialog).mockImplementation(showMessageBox)
  ;(window as any).electronAPI = {
    file: { writeMarkdown, readMarkdown: vi.fn().mockResolvedValue({ success: true, data: 'external change' }) },
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
  vi.mocked(showMessageDialog).mockReset()
  vi.useFakeTimers()
  setActivePinia(createPinia())
  ;(globalThis as any).window = globalThis.window || globalThis
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('workspace per-file save serialization', () => {
  it('cancels an obsolete queued snapshot, preserves newer input and saves it with the latest baseline', async () => {
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
    store.setActiveFileContent('second', 'note.md')
    const second = store.saveActiveFileContent('second', 'note.md')
    store.setActiveFileContent('third', 'note.md')
    expect(write).toHaveBeenCalledTimes(1)
    release.resolve()
    expect((await first).success).toBe(true)
    expect((await second).success).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    expect(store.openedTextFileContents['note.md']).toMatchObject({ content: 'third', loadedContent: 'first' })
    expect((await store.saveActiveFileContent('third', 'note.md')).success).toBe(true)
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
    store.setActiveFileContent('second', 'note.md')
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
    expect(await queued).toEqual({ success: false, error: '笔记已更新或关闭，已取消旧版本保存。' })
    expect(write).toHaveBeenCalledTimes(1)
    expect(store.openedTextFileContents['note.md']).toEqual({ ...textState('reopened'), loadRequestId: 2 })
  })

  it('saves a still-current queued snapshot after its predecessor updates the baseline', async () => {
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
    store.setActiveFileContent('second', 'note.md')
    const second = store.saveActiveFileContent('second', 'note.md')
    expect(write).toHaveBeenCalledTimes(1)
    release.resolve()
    expect((await first).success).toBe(true)
    expect((await second).success).toBe(true)
    expect(write.mock.calls.map(call => call.slice(1))).toEqual([['first', 'saved'], ['second', 'first']])
    expect(disk).toBe('second')
  })

  it('does not swallow an explicit retry overlapping an automatically paused save', async () => {
    const confirm = vi.fn().mockResolvedValue({ response: 1 })
    const write = vi.fn()
    const store = setup(write, confirm)
    store.setActiveFileContent('', 'note.md')
    store.openedTextFileContents['note.md'].saveConfirmationDismissed = true
    const automatic = store.saveActiveFileContent('', 'note.md', { automatic: true })
    const explicit = store.saveActiveFileContent('', 'note.md')
    expect((await automatic).success).toBe(false)
    expect((await explicit).success).toBe(false)
    expect(confirm).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
  })

  it('does not carry an old saving flag to a moved file or let the old callback modify it', async () => {
    const entered = barrier(), release = barrier()
    const write = vi.fn(async () => { entered.resolve(); await release.promise; return { success: true } })
    const store = setup(write)
    store.setActiveFileContent('draft', 'note.md')
    const saving = store.saveActiveFileContent('draft', 'note.md')
    await entered.promise
    store.remapOpenedTextFileStates([{ from: 'note.md', to: 'renamed.md' }])
    expect(store.openedTextFileContents['renamed.md'].isSaving).toBe(false)
    release.resolve()
    expect((await saving).success).toBe(false)
    expect(store.openedTextFileContents['renamed.md']).toMatchObject({ content: 'draft', loadedContent: 'saved', isSaving: false })
    expect((await store.saveActiveFileContent('draft', 'renamed.md')).success).toBe(true)
    expect(store.openedTextFileContents['renamed.md'].loadedContent).toBe('draft')
  })
})
