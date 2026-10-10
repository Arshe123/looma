import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

const legacy = '[文字](../医渡云相关信息.md#4. 国家疾控管理后台)'
const normalized = '[文字](../医渡云相关信息.md#4.%20国家疾控管理后台)'

function setup(relativePath = 'note.md', baseline = legacy) {
  const writeMarkdown = vi.fn().mockResolvedValue({ success: true })
  const saveDraft = vi.fn().mockResolvedValue({ success: true })
  const removeDraft = vi.fn().mockResolvedValue({ success: true })
  vi.stubGlobal('window', { electronAPI: {
    file: { writeMarkdown },
    draftRecovery: { save: saveDraft, remove: removeDraft },
  } })
  const store = useWorkspaceStore()
  store.workspaces = [{ id: 'workspace-1', name: 'Notes', path: '/notes', createdAt: 1, lastOpenedAt: 1 }]
  store.activeWorkspaceId = 'workspace-1'
  store.activeFileRelativePath = relativePath
  store.activeFilePath = `/notes/${relativePath}`
  store.openedTextFileContents[relativePath] = {
    content: baseline, loadedContent: baseline, isSaving: false, saveError: '',
    isPartial: false, isLoading: false, isLoadingMore: false,
    nextOffset: baseline.length, totalBytes: baseline.length, loadRequestId: 1,
    useChunkedPreview: false,
  }
  return { store, writeMarkdown, saveDraft, removeDraft }
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('workspace note-link save normalization', () => {
  it('leaves TXT content untouched', async () => {
    const { store, writeMarkdown } = setup('note.txt', 'saved')
    expect((await store.saveActiveFileContent(legacy, 'note.txt')).success).toBe(true)
    expect(writeMarkdown).toHaveBeenCalledWith('/notes/note.txt', legacy, 'saved')
    expect(store.openedTextFileContents['note.txt'].content).toBe(legacy)
    expect(store.openedTextFileContents['note.txt'].loadedContent).toBe(legacy)
  })

  it('keeps newer edits and rebases their recovery draft after a normalized save', async () => {
    const { store, writeMarkdown, saveDraft, removeDraft } = setup()
    let finish!: (value: { success: true }) => void
    writeMarkdown.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const saving = store.saveActiveFileContent(legacy, 'note.md')
    await vi.advanceTimersByTimeAsync(0)
    expect(writeMarkdown).toHaveBeenCalledWith('/notes/note.md', normalized, legacy)
    const savingRevision = store.openedTextFileContents['note.md'].recoveryRevision
    store.setActiveFileContent(`${legacy}\nnew edit`, 'note.md')
    const newerRevision = store.openedTextFileContents['note.md'].recoveryRevision
    finish({ success: true })
    expect((await saving).success).toBe(true)
    expect(store.openedTextFileContents['note.md'].content).toBe(`${legacy}\nnew edit`)
    expect(store.openedTextFileContents['note.md'].loadedContent).toBe(normalized)
    expect(store.isFileDirty('note.md')).toBe(true)
    expect(newerRevision).not.toBe(savingRevision)
    expect(removeDraft).toHaveBeenCalledWith('workspace-1', 'note.md', savingRevision)
    await vi.advanceTimersByTimeAsync(500)
    expect(saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      draftContent: `${legacy}\nnew edit`, baseContent: normalized,
      revision: store.openedTextFileContents['note.md'].recoveryRevision,
    }))
  })

  it.each([false, true])('preserves the disk baseline and recovery draft on failed save (new edits: %s)', async newerEdits => {
    const { store, writeMarkdown, saveDraft, removeDraft } = setup()
    let finish!: (value: { success: false; error: string }) => void
    writeMarkdown.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const saving = store.saveActiveFileContent(legacy, 'note.md')
    await vi.advanceTimersByTimeAsync(0)
    expect(writeMarkdown).toHaveBeenCalledWith('/notes/note.md', normalized, legacy)
    if (newerEdits) store.setActiveFileContent(`${legacy}\nnew edit`, 'note.md')
    finish({ success: false, error: 'disk full' })
    expect((await saving).success).toBe(false)
    expect(store.openedTextFileContents['note.md'].content).toBe(newerEdits ? `${legacy}\nnew edit` : normalized)
    expect(store.openedTextFileContents['note.md'].loadedContent).toBe(legacy)
    expect(store.openedTextFileContents['note.md'].isSaving).toBe(false)
    expect(store.openedTextFileContents['note.md'].saveError).toBe('disk full')
    expect(removeDraft).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      draftContent: newerEdits ? `${legacy}\nnew edit` : normalized, baseContent: legacy,
    }))
  })

  it('normalizes Markdown before the save snapshot without changing its disk baseline', async () => {
    const { store, writeMarkdown, saveDraft } = setup()
    expect((await store.saveActiveFileContent(legacy, 'note.md')).success).toBe(true)
    expect(writeMarkdown).toHaveBeenCalledWith('/notes/note.md', normalized, legacy)
    expect(store.openedTextFileContents['note.md'].content).toBe(normalized)
    expect(store.openedTextFileContents['note.md'].loadedContent).toBe(normalized)
    expect(store.isFileDirty('note.md')).toBe(false)
    expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({ draftContent: normalized, baseContent: legacy }))
  })
})
