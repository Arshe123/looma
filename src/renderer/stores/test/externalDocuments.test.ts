import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useExternalDocumentsStore } from '../externalDocuments'

const doc = { id: 'canonical-id', filePath: '/tmp/note.md', content: '# Disk', baseContent: '# Disk' }
const legacyLink = '[文字](../医渡云相关信息.md#4. 国家疾控管理后台)'
const normalizedLink = '[文字](../医渡云相关信息.md#4.%20国家疾控管理后台)'
beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('window', { location: { search: '?editorOnly=1' }, electronAPI: { window: { close: vi.fn().mockResolvedValue(undefined) }, externalDocuments: {
    draft: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
  }, app: { showMessageBox: vi.fn().mockResolvedValue({ response: 2 }) } } })
})
it.each(['dirty', 'clean'])('normalizes an explicit %s Markdown save while retaining the disk baseline', async state => {
  const store = useExternalDocumentsStore()
  const baseline = state === 'clean' ? legacyLink : doc.baseContent
  store.open({ ...doc, content: legacyLink, baseContent: baseline })
  expect(await store.save(doc.id, true)).toBe(true)
  expect(window.electronAPI.externalDocuments.save).toHaveBeenCalledWith(doc.id, normalizedLink, baseline)
  expect(store.documents[0].content).toBe(normalizedLink)
  expect(store.documents[0].baseContent).toBe(normalizedLink)
  expect(store.dirty(doc.id)).toBe(false)
  expect(window.electronAPI.externalDocuments.draft).toHaveBeenCalledWith(doc.id, normalizedLink, normalizedLink)
})
it('keeps a clean unchanged Markdown explicit save a no-op', async () => {
  const store = useExternalDocumentsStore()
  store.open({ ...doc, content: normalizedLink, baseContent: normalizedLink })
  expect(await store.save(doc.id, true)).toBe(true)
  expect(window.electronAPI.externalDocuments.save).not.toHaveBeenCalled()
  expect(window.electronAPI.externalDocuments.draft).not.toHaveBeenCalled()
})
it('clears dirty state when legacy content normalizes to the existing disk baseline', async () => {
  const store = useExternalDocumentsStore()
  store.open({ ...doc, content: legacyLink, baseContent: normalizedLink })
  expect(await store.save(doc.id, true)).toBe(true)
  expect(window.electronAPI.externalDocuments.save).not.toHaveBeenCalled()
  expect(store.documents[0].content).toBe(normalizedLink)
  expect(store.dirty(doc.id)).toBe(false)
  expect(window.electronAPI.externalDocuments.draft).toHaveBeenCalledWith(doc.id, normalizedLink, normalizedLink)
})
it('leaves external TXT saves untouched', async () => {
  const store = useExternalDocumentsStore()
  store.open({ ...doc, filePath: '/tmp/note.txt', content: legacyLink })
  expect(await store.save(doc.id, true)).toBe(true)
  expect(window.electronAPI.externalDocuments.save).toHaveBeenCalledWith(doc.id, legacyLink, doc.baseContent)
  expect(store.documents[0].content).toBe(legacyLink)
  expect(store.documents[0].baseContent).toBe(legacyLink)
})
it('preserves edits made during a normalized external save and rebases their draft', async () => {
  const store = useExternalDocumentsStore()
  store.open({ ...doc, content: legacyLink })
  let finish!: () => void
  vi.mocked(window.electronAPI.externalDocuments.save).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const saving = store.save(doc.id)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(window.electronAPI.externalDocuments.save).toHaveBeenCalledWith(doc.id, normalizedLink, doc.baseContent)
  store.update(doc.id, `${legacyLink}\nnew edit`)
  finish()
  expect(await saving).toBe(true)
  expect(store.documents[0].content).toBe(`${legacyLink}\nnew edit`)
  expect(store.documents[0].baseContent).toBe(normalizedLink)
  expect(store.dirty(doc.id)).toBe(true)
  expect(window.electronAPI.externalDocuments.draft).toHaveBeenCalledWith(doc.id, `${legacyLink}\nnew edit`, normalizedLink)
})
it.each([false, true])('preserves external content and baseline on failed normalized save (new edits: %s)', async newerEdits => {
  const store = useExternalDocumentsStore()
  store.open({ ...doc, content: legacyLink })
  let fail!: (error: Error) => void
  vi.mocked(window.electronAPI.externalDocuments.save).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject }))
  const saving = store.save(doc.id, true)
  await vi.waitFor(() => expect(fail).toBeTypeOf('function'))
  expect(window.electronAPI.externalDocuments.save).toHaveBeenCalledWith(doc.id, normalizedLink, doc.baseContent)
  if (newerEdits) store.update(doc.id, `${legacyLink}\nnew edit`)
  fail(new Error('disk full'))
  expect(await saving).toBe(false)
  expect(store.documents[0].content).toBe(newerEdits ? `${legacyLink}\nnew edit` : legacyLink)
  expect(store.documents[0].baseContent).toBe(doc.baseContent)
  expect(store.documents[0].saving).toBe(false)
  expect(store.documents[0].error).toContain('disk full')
  expect(store.dirty(doc.id)).toBe(true)
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
