import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileService } from '../../../main/services/file/fileService'
import { useWorkspaceStore } from '../workspace'
import { showMessageDialog } from '../message-dialog'

vi.mock('../message-dialog', async importOriginal => {
  const actual = await importOriginal<typeof import('../message-dialog')>()
  return { ...actual, showMessageDialog: vi.fn() }
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let directory: string

async function setup(content = '') {
  const filePath = join(directory, 'note.md')
  await writeFile(filePath, 'original')
  const confirmations: ReturnType<typeof deferred<{ response: number }>>[] = []
  const showMessageBox = vi.mocked(showMessageDialog).mockReset().mockImplementation(() => {
    const confirmation = deferred<{ response: number }>()
    confirmations.push(confirmation)
    return confirmation.promise
  })
  const writeMarkdown = vi.fn(fileService.writeMarkdown)
  const readMarkdown = vi.fn(fileService.readMarkdown)
  const saveDraft = vi.fn().mockResolvedValue({ success: true })
  const removeDraft = vi.fn().mockResolvedValue({ success: true })
  vi.stubGlobal('window', { electronAPI: {
    file: { writeMarkdown, readMarkdown },
    draftRecovery: { save: saveDraft, remove: removeDraft },
  } })
  const store = useWorkspaceStore()
  store.workspaces = [{ id: 'ws', name: 'Notes', path: directory, createdAt: 1, lastOpenedAt: 1 }]
  store.activeWorkspaceId = 'ws'
  store.activeFileRelativePath = 'note.md'
  store.openedTextFileContents['note.md'] = {
    content, loadedContent: 'original', isSaving: false, saveError: '',
    isPartial: false, isLoading: false, isLoadingMore: false,
    nextOffset: 8, totalBytes: 8, loadRequestId: 1, useChunkedPreview: false,
  }
  return { store, filePath, confirmations, showMessageBox, writeMarkdown, readMarkdown, saveDraft, removeDraft }
}

beforeEach(async () => {
  setActivePinia(createPinia())
  directory = await mkdtemp(join(tmpdir(), 'looma-save-transaction-'))
})
afterEach(async () => {
  useWorkspaceStore().cancelDraftRecoveryTimer('note.md')
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

describe('workspace save transactions with real disk writes', () => {
  it.each(['pending input', 'reopened file', 'workspace switch'])('rejects a stale confirmation after %s', async change => {
    const p = await setup()
    const saving = p.store.saveActiveFileContent('', 'note.md')
    if (change === 'pending input') p.store.markTextFileEditPending('note.md')
    if (change === 'reopened file') p.store.openedTextFileContents['note.md'] = {
      ...p.store.openedTextFileContents['note.md'], content: 'reopened', loadRequestId: 2, isSaving: false,
    }
    if (change === 'workspace switch') p.store.activeWorkspaceId = 'other'
    p.confirmations[0].resolve({ response: 0 })
    expect((await saving).success).toBe(false)
    expect(p.writeMarkdown).not.toHaveBeenCalled()
    expect(await readFile(p.filePath, 'utf8')).toBe('original')
    if (change === 'reopened file') expect(p.store.openedTextFileContents['note.md'].content).toBe('reopened')
  })

  it('does not apply a completed old write to a reopened file instance', async () => {
    const p = await setup('draft')
    const release = deferred<void>()
    p.writeMarkdown.mockImplementationOnce(async (...args) => {
      await release.promise
      return fileService.writeMarkdown(...args)
    })
    const saving = p.store.saveActiveFileContent('draft', 'note.md')
    await vi.waitFor(() => expect(p.writeMarkdown).toHaveBeenCalledOnce())
    p.store.openedTextFileContents['note.md'] = {
      ...p.store.openedTextFileContents['note.md'], content: 'reopened', loadedContent: 'reopened', loadRequestId: 2, isSaving: false,
    }
    release.resolve()
    expect((await saving).success).toBe(false)
    expect(p.store.openedTextFileContents['note.md']).toMatchObject({ content: 'reopened', loadedContent: 'reopened', isSaving: false })
    expect(p.removeDraft).not.toHaveBeenCalled()
  })

  it('still rejects disk changes made after the overwrite confirmation was opened', async () => {
    const p = await setup('draft')
    await writeFile(p.filePath, 'external version one')
    p.store.openedTextFileContents['note.md'].recoveryConflict = true
    const saving = p.store.saveActiveFileContent('draft', 'note.md')
    await vi.waitFor(() => expect(p.confirmations).toHaveLength(1))
    await writeFile(p.filePath, 'external version two')
    p.confirmations[0].resolve({ response: 0 })
    expect(await saving).toMatchObject({ success: false, errorCode: 'FILE_CHANGED_ON_DISK' })
    expect(await readFile(p.filePath, 'utf8')).toBe('external version two')
    expect(p.store.openedTextFileContents['note.md']).toMatchObject({ content: 'draft', loadedContent: 'original', recoveryConflict: true })
  })

  it('replays a disk change deferred during a cancelled confirmation', async () => {
    const p = await setup()
    let listener!: (event: any) => void
    window.electronAPI.fs = { onEvent: (handler: typeof listener) => { listener = handler; return () => {} } } as any
    p.store.attachFsEvents()
    const saving = p.store.saveActiveFileContent('', 'note.md')
    expect(p.store.openedTextFileContents['note.md'].isSaving).toBe(true)
    await writeFile(p.filePath, 'external')
    listener({ workspaceId: 'ws', relativePath: 'note.md', event: 'change', origin: 'external' })
    expect(p.readMarkdown).not.toHaveBeenCalled()
    p.confirmations[0].resolve({ response: 1 })
    expect((await saving).success).toBe(false)
    expect(p.readMarkdown).toHaveBeenCalledOnce()
    expect(p.store.openedTextFileContents['note.md']).toMatchObject({ content: '', recoveryConflict: true, isSaving: false })
  })

  it('clears the resolved disk conflict even when newer edits arrive during the approved write', async () => {
    const p = await setup('draft')
    await writeFile(p.filePath, 'external')
    p.store.openedTextFileContents['note.md'].recoveryConflict = true
    p.showMessageBox.mockResolvedValue({ response: 0 })
    const release = deferred<void>()
    p.writeMarkdown.mockImplementationOnce(async (...args) => {
      await release.promise
      return fileService.writeMarkdown(...args)
    })
    const saving = p.store.saveActiveFileContent('draft', 'note.md')
    await vi.waitFor(() => expect(p.writeMarkdown).toHaveBeenCalledOnce())
    p.store.setActiveFileContent('newer draft', 'note.md')
    release.resolve()
    expect((await saving).success).toBe(true)
    expect(p.store.openedTextFileContents['note.md']).toMatchObject({ content: 'newer draft', loadedContent: 'draft', recoveryConflict: false })
    expect((await p.store.saveActiveFileContent('newer draft', 'note.md')).success).toBe(true)
    expect(p.showMessageBox).toHaveBeenCalledOnce()
  })

  it('reconciles a stale conflict when the disk already contains the requested content', async () => {
    const p = await setup()
    await writeFile(p.filePath, '')
    p.store.openedTextFileContents['note.md'].recoveryConflict = true
    p.showMessageBox.mockResolvedValue({ response: 1 })

    expect((await p.store.saveActiveFileContent('', 'note.md')).success).toBe(true)
    expect(p.showMessageBox).not.toHaveBeenCalled()
    expect(p.store.openedTextFileContents['note.md']).toMatchObject({ loadedContent: '', recoveryConflict: false, isSaving: false })
    expect(p.store.isFileDirty('note.md')).toBe(false)
  })

  it('drops an obsolete queued save instead of replacing newer edits', async () => {
    const p = await setup('first')
    const release = deferred<void>()
    p.writeMarkdown.mockImplementationOnce(async (...args) => {
      await release.promise
      return fileService.writeMarkdown(...args)
    })
    const first = p.store.saveActiveFileContent('first', 'note.md')
    await vi.waitFor(() => expect(p.writeMarkdown).toHaveBeenCalledOnce())
    p.store.setActiveFileContent('second', 'note.md')
    const queued = p.store.saveActiveFileContent('second', 'note.md')
    p.store.setActiveFileContent('third', 'note.md')
    release.resolve()
    expect((await first).success).toBe(true)
    expect((await queued).success).toBe(false)
    expect(p.store.openedTextFileContents['note.md']).toMatchObject({ content: 'third', loadedContent: 'first' })
    expect(p.writeMarkdown).toHaveBeenCalledOnce()
    expect((await p.store.saveActiveFileContent('third', 'note.md')).success).toBe(true)
    expect(await readFile(p.filePath, 'utf8')).toBe('third')
  })

  it('releases a rejected save and keeps the draft available for retry', async () => {
    const p = await setup('draft')
    p.writeMarkdown.mockRejectedValueOnce(new Error('IPC unavailable'))
    await expect(p.store.saveActiveFileContent('draft', 'note.md')).resolves.toMatchObject({ success: false })
    expect(p.store.openedTextFileContents['note.md']).toMatchObject({ content: 'draft', loadedContent: 'original', isSaving: false })
    expect(p.store.openedTextFileContents['note.md'].saveError).toContain('保存失败')
    expect(p.removeDraft).not.toHaveBeenCalled()
    expect((await p.store.saveActiveFileContent('draft', 'note.md')).success).toBe(true)
    expect(await readFile(p.filePath, 'utf8')).toBe('draft')
  })

  it('does not repeat a cancelled clear dialog on autosave, but allows an explicit retry', async () => {
    const p = await setup()
    p.showMessageBox.mockResolvedValue({ response: 1 })
    const save = p.store.saveActiveFileContent
    expect((await save('', 'note.md', { automatic: true })).success).toBe(false)
    expect((await save('', 'note.md', { automatic: true })).success).toBe(false)
    const automaticDialogCount = p.showMessageBox.mock.calls.length
    expect((await save('', 'note.md')).success).toBe(false)

    expect(automaticDialogCount).toBe(1)
    expect(p.showMessageBox).toHaveBeenCalledTimes(2)
    expect(p.writeMarkdown).not.toHaveBeenCalled()
    expect(p.store.isFileDirty('note.md')).toBe(true)
  })

  it('keeps edits made while the clear confirmation is pending', async () => {
    const p = await setup()
    const saving = p.store.saveActiveFileContent('', 'note.md')
    p.store.setActiveFileContent('new text', 'note.md')
    p.confirmations[0].resolve({ response: 0 })

    expect((await saving).success).toBe(false)
    expect(p.writeMarkdown).not.toHaveBeenCalled()
    expect(p.store.openedTextFileContents['note.md'].content).toBe('new text')
    expect(await readFile(p.filePath, 'utf8')).toBe('original')
  })

  it('overwrites the confirmed disk version instead of retrying with the old baseline', async () => {
    const p = await setup('draft')
    await writeFile(p.filePath, 'external')
    p.store.openedTextFileContents['note.md'].recoveryConflict = true
    const saving = p.store.saveActiveFileContent('draft', 'note.md')
    await vi.waitFor(() => expect(p.confirmations).toHaveLength(1))
    p.confirmations[0].resolve({ response: 0 })

    expect((await saving).success).toBe(true)
    expect(p.writeMarkdown).toHaveBeenCalledWith(p.filePath, 'draft', 'external')
    expect(await readFile(p.filePath, 'utf8')).toBe('draft')
    expect(p.store.isFileDirty('note.md')).toBe(false)
  })

  it('shares one clear confirmation and write between overlapping saves', async () => {
    const p = await setup()
    const first = p.store.saveActiveFileContent('', 'note.md')
    const second = p.store.saveActiveFileContent('', 'note.md')
    const count = p.confirmations.length
    for (const confirmation of p.confirmations) confirmation.resolve({ response: 0 })
    const results = await Promise.all([first, second])

    expect(count).toBe(1)
    expect(results.every(result => result.success)).toBe(true)
    expect(p.writeMarkdown).toHaveBeenCalledOnce()
    expect(await readFile(p.filePath, 'utf8')).toBe('')
    expect(p.store.openedTextFileContents['note.md']).toMatchObject({
      content: '', loadedContent: '', isSaving: false, recoveryConflict: false,
    })
    expect(p.store.isFileDirty('note.md')).toBe(false)
  })
})
