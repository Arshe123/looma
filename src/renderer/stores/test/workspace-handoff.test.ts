import { readFileSync } from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'
import { useExternalDocumentsStore } from '../externalDocuments'

beforeEach(() => { setActivePinia(createPinia()) })
it('does not claim a contained file if durable workspace recovery fails', async () => {
  vi.stubGlobal('window', { electronAPI: { draftRecovery: { save: vi.fn().mockResolvedValue({ success: false, error: 'disk full' }) } } })
  const store = useWorkspaceStore()
  store.activeWorkspaceId = 'target'
  const claim = vi.fn()
  await expect(store.adoptExternalDocument('inside.md', { id: 'file', filePath: '/target/inside.md', content: 'latest', baseContent: 'disk' }, 'disk', claim)).rejects.toThrow('disk full')
  expect(claim).not.toHaveBeenCalled()
  expect(store.tabs).toHaveLength(0)
  expect(store.openedTextFileContents['inside.md']).toBeUndefined()
})
it('rolls back staged workspace recovery when the transfer expires', async () => {
  const remove = vi.fn().mockResolvedValue({ success: true })
  vi.stubGlobal('window', { electronAPI: { draftRecovery: { save: vi.fn().mockResolvedValue({ success: true }), remove } } })
  const store = useWorkspaceStore()
  store.activeWorkspaceId = 'target'
  await expect(store.adoptExternalDocument('inside.md', { id: 'file', filePath: '/target/inside.md', content: 'latest', baseContent: 'disk' }, 'disk', async () => { throw new Error('expired') })).rejects.toThrow('expired')
  expect(remove).toHaveBeenCalledWith('target', 'inside.md', expect.any(String))
  expect(store.tabs).toHaveLength(0)
})
it('never replaces an existing dirty target tab', async () => {
  const store = useWorkspaceStore()
  store.activeWorkspaceId = 'target'
  store.openedTextFileContents['inside.md'] = { content: 'target dirty', loadedContent: 'disk' } as any
  const claim = vi.fn()
  await expect(store.adoptExternalDocument('inside.md', { id: 'file', filePath: '/target/inside.md', content: 'source dirty', baseContent: 'disk' }, 'disk', claim)).rejects.toThrow('未保存')
  expect(claim).not.toHaveBeenCalled()
  expect(store.openedTextFileContents['inside.md'].content).toBe('target dirty')
})
it('adopts a contained file as a normal dirty tab with its original conflict baseline', async () => {
  vi.stubGlobal('window', { electronAPI: { draftRecovery: { save: vi.fn().mockResolvedValue({ success: true }) }, externalDocuments: { close: vi.fn().mockResolvedValue(undefined) } } })
  const store = useWorkspaceStore()
  store.activeWorkspaceId = 'target'
  const open = vi.spyOn(store, 'openFileTab').mockImplementation(() => {})
  await store.adoptExternalDocument('inside.md', { id: 'file', filePath: '/target/inside.md', content: 'latest', baseContent: 'original' }, 'disk conflict')
  expect(open).toHaveBeenCalledWith('inside.md')
  expect(store.openedTextFileContents['inside.md']).toMatchObject({ content: 'latest', loadedContent: 'original', recoveryConflict: true })
  expect(store.isFileDirty('inside.md')).toBe(true)
  expect(window.electronAPI.draftRecovery.save).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'target', relativePath: 'inside.md', draftContent: 'latest', baseContent: 'original' }))
  expect(window.electronAPI.externalDocuments.close).toHaveBeenCalledWith('file')
})
it('keeps the source intact and blocks close while a failed transfer is pending', async () => {
  let reject!: (error: Error) => void
  vi.stubGlobal('window', { electronAPI: { externalDocuments: { transfer: vi.fn(() => new Promise((_resolve, fail) => { reject = fail })) } } })
  const store = useExternalDocumentsStore()
  store.open({ id: 'current', filePath: '/current.md', content: 'dirty', baseContent: 'disk' })
  const moving = store.transferCurrent('target')
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
  expect(await store.close('current')).toBe(false)
  reject(new Error('target unavailable'))
  expect(await moving).toBe(false)
  expect(store.documents[0].content).toBe('dirty')
  expect(store.activeId).toBe('current')
  expect(store.transferring).toBe(false)
})
it('routes workspace opens through current-document handoff', async () => {
  vi.stubGlobal('window', { electronAPI: { workspace: { checkExists: vi.fn().mockResolvedValue({ success: true, data: { exists: true } }) }, window: { openWorkspace: vi.fn() } } })
  const external = useExternalDocumentsStore()
  external.open({ id: 'current', filePath: '/current.md', content: 'disk', baseContent: 'disk' })
  const move = vi.spyOn(external, 'transferCurrent').mockResolvedValue(true)
  await useWorkspaceStore().openWorkspaceInNewWindow('target')
  expect(move).toHaveBeenCalledWith('target')
  expect((window.electronAPI.window as any).openWorkspace).not.toHaveBeenCalled()
})
it('loads history without restoring a workspace in editor-only startup', async () => {
  const list = [{ id: 'target', name: 'Target', path: '/target', createdAt: 1 }]
  vi.stubGlobal('window', { electronAPI: { workspace: { list: vi.fn().mockResolvedValue({ success: true, data: list }) } } })
  const store = useWorkspaceStore()
  await store.refreshWorkspaces()
  expect(store.workspaces).toEqual(list)
  expect(store.activeWorkspaceId).toBeNull()
  const app = readFileSync('src/renderer/App.vue', 'utf8')
  expect(app).toMatch(/if \(editorOnly\)\s*\{[^}]*await workspaceStore.refreshWorkspaces\(\)/)
})
it('hands off only the current file after flushing pending rich text, without saving disk', async () => {
  const transfer = vi.fn().mockResolvedValue(undefined)
  const draft = vi.fn().mockResolvedValue(undefined)
  const save = vi.fn()
  vi.stubGlobal('window', { electronAPI: { externalDocuments: { transfer, draft, save } } })
  const store = useExternalDocumentsStore()
  store.open({ id: 'other', filePath: '/other.md', content: 'other', baseContent: 'other' })
  store.open({ id: 'current', filePath: '/current.md', content: 'disk', baseContent: 'disk' })
  store.markPending('current')
  store.registerFlush('current', () => store.update('current', 'latest'))
  expect(await store.transferCurrent('target')).toBe(true)
  expect(transfer).toHaveBeenCalledWith('target', 'current', 'latest', 'disk')
  expect(save).not.toHaveBeenCalled()
  expect(store.documents.map(doc => doc.id)).toEqual(['other'])
})
