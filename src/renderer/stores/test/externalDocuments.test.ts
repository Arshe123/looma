import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useExternalDocumentsStore } from '../externalDocuments'

const doc = { id: 'canonical-id', filePath: '/tmp/note.md', content: '# Disk', baseContent: '# Disk' }
beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('window', { location: { search: '?editorOnly=1' }, electronAPI: { window: { close: vi.fn().mockResolvedValue(undefined) }, externalDocuments: {
    draft: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
  }, app: { showMessageBox: vi.fn().mockResolvedValue({ response: 2 }) } } })
})
it('closes the editor-only window after its last tab closes successfully', async () => {
  const store = useExternalDocumentsStore()
  expect(window.electronAPI.window.close).not.toHaveBeenCalled()
  store.open(doc)
  store.open({ ...doc, id: 'second', filePath: '/tmp/second.md' })
  expect(await store.close(doc.id)).toBe(true)
  expect(window.electronAPI.window.close).not.toHaveBeenCalled()
  expect(await store.close('second')).toBe(true)
  expect(store.documents).toHaveLength(0)
  expect(window.electronAPI.window.close).toHaveBeenCalledOnce()
})
it('keeps workspace windows open after their last external tab closes', async () => {
  window.location.search = '?workspaceId=fixture'
  const store = useExternalDocumentsStore()
  store.open(doc)
  expect(await store.close(doc.id)).toBe(true)
  expect(window.electronAPI.window.close).not.toHaveBeenCalled()
})
it('leaves final window closure to the coordinator when closing the whole window', async () => {
  const store = useExternalDocumentsStore()
  store.open(doc)
  expect(await store.closeAll()).toBe(true)
  expect(store.documents).toHaveLength(0)
  expect(window.electronAPI.window.close).not.toHaveBeenCalled()
})
it.each(['cancel', 'save-failure', 'close-failure'])('keeps the last tab and window on %s', async reason => {
  const store = useExternalDocumentsStore()
  store.open(doc)
  if (reason === 'close-failure') {
    vi.mocked(window.electronAPI.externalDocuments.close).mockRejectedValue(new Error('close failed'))
  } else {
    store.update(doc.id, '# Dirty')
    if (reason === 'save-failure') {
      vi.mocked(window.electronAPI.app.showMessageBox).mockResolvedValue({ response: 0 } as any)
      vi.mocked(window.electronAPI.externalDocuments.save).mockRejectedValue(new Error('save failed'))
    }
  }
  expect(await store.close(doc.id)).toBe(false)
  expect(store.documents).toHaveLength(1)
  expect(window.electronAPI.window.close).not.toHaveBeenCalled()
})
it('keeps new edits made during save dirty and rebases their crash draft', async () => {
  const store = useExternalDocumentsStore()
  store.open(doc)
  store.update(doc.id, '# One')
  let finish!: () => void
  vi.mocked(window.electronAPI.externalDocuments.save).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const saving = store.save(doc.id)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  store.update(doc.id, '# Two')
  finish()
  expect(await saving).toBe(true)
  expect(store.documents[0].baseContent).toBe('# One')
  expect(store.documents[0].content).toBe('# Two')
  expect(store.dirty(doc.id)).toBe(true)
  expect(window.electronAPI.externalDocuments.draft).toHaveBeenCalledWith(doc.id, '# Two', '# One')
})
it('does not close over edits made while the final save is in flight', async () => {
  const store = useExternalDocumentsStore()
  store.open(doc)
  store.update(doc.id, '# One')
  vi.mocked(window.electronAPI.app.showMessageBox).mockResolvedValue({ response: 0 } as any)
  let finish!: () => void
  vi.mocked(window.electronAPI.externalDocuments.save).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const closing = store.close(doc.id)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  store.update(doc.id, '# Two')
  finish()
  expect(await closing).toBe(false)
  expect(store.documents[0].content).toBe('# Two')
  expect(window.electronAPI.externalDocuments.close).not.toHaveBeenCalled()
})
it('recovery failures never block saving the original', async () => {
  const store = useExternalDocumentsStore()
  store.open(doc)
  vi.mocked(window.electronAPI.externalDocuments.draft).mockRejectedValue(new Error('disk full'))
  store.update(doc.id, '# Edited')
  expect(await store.save(doc.id)).toBe(true)
  expect(store.dirty(doc.id)).toBe(false)
  expect(store.documents[0].recoveryError).toContain('恢复草稿')
})
it('focuses duplicate opens without replacing pending edits; flushes before cancellable close', async () => {
  const store = useExternalDocumentsStore()
  store.open(doc)
  store.update(doc.id, '# Dirty')
  store.open({ ...doc, content: '# New disk' })
  expect(store.documents[0].content).toBe('# Dirty')
  const flush = vi.fn(() => { store.update(doc.id, '# Latest rich text') })
  store.registerFlush(doc.id, flush)
  expect(await store.close(doc.id)).toBe(false)
  expect(flush).toHaveBeenCalledOnce()
  expect(store.documents[0].content).toBe('# Latest rich text')
  expect(window.electronAPI.externalDocuments.close).not.toHaveBeenCalled()
})
