import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

const workspace = {
  id: 'workspace-1',
  name: 'Notes',
  path: '/notes',
  createdAt: 1,
  lastOpenedAt: 1,
}

const createTextState = (content: string) => ({
  content,
  loadedContent: content,
  isSaving: false,
  saveError: '',
  isPartial: false,
  isLoading: false,
  isLoadingMore: false,
  nextOffset: content.length,
  totalBytes: content.length,
  loadRequestId: 1,
  useChunkedPreview: false,
})

describe('workspace draft recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    ;(globalThis as any).window = globalThis.window || globalThis
  })

  it('persists changed content after a short debounce without writing the note file', async () => {
    const saveDraft = vi.fn().mockResolvedValue({ success: true })
    const writeMarkdown = vi.fn()
    ;(window as any).electronAPI = {
      draftRecovery: { save: saveDraft, remove: vi.fn().mockResolvedValue({ success: true }) },
      file: { writeMarkdown },
    }
    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.activeFileRelativePath = 'note.md'
    store.activeFilePath = '/notes/note.md'
    store.openedTextFileContents['note.md'] = createTextState('saved')

    store.setActiveFileContent('draft', 'note.md')
    await vi.advanceTimersByTimeAsync(500)

    expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: workspace.id,
      relativePath: 'note.md',
      draftContent: 'draft',
      baseContent: 'saved',
      revision: expect.any(String),
    }))
    expect(writeMarkdown).not.toHaveBeenCalled()
  })

  it('treats an editor update awaiting serialization as dirty', () => {
    const store = useWorkspaceStore()
    store.openedTextFileContents['note.md'] = {
      ...createTextState('saved'),
      hasPendingEditorChanges: true,
    }

    expect(store.isFileDirty('note.md')).toBe(true)
  })

  it('restores a draft over disk content and leaves the file marked dirty', async () => {
    (window as any).electronAPI = {
      file: {
        readTextChunk: vi.fn().mockResolvedValue({
          success: true,
          data: { content: 'saved', offset: 0, nextOffset: 5, totalBytes: 5, done: true },
        }),
      },
      draftRecovery: {
        get: vi.fn().mockResolvedValue({
          success: true,
          data: {
            status: 'restorable',
            draft: {
              schemaVersion: 1,
              workspaceId: workspace.id,
              relativePath: 'note.md',
              draftContent: 'recovered draft',
              baseContentHash: 'hash',
              revision: 'recovered-revision',
              updatedAt: 1,
            },
          },
        }),
      },
    }
    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id

    await store.loadTextFileContent('note.md')

    expect(store.openedTextFileContents['note.md'].content).toBe('recovered draft')
    expect(store.openedTextFileContents['note.md'].loadedContent).toBe('saved')
    expect(store.isFileDirty('note.md')).toBe(true)
  })

  it('does not erase newer edits or their recovery draft when an older save completes', async () => {
    let finishWrite!: (value: { success: true }) => void
    const writePromise = new Promise<{ success: true }>((resolve) => { finishWrite = resolve })
    const removeDraft = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).electronAPI = {
      file: { writeMarkdown: vi.fn(() => writePromise) },
      draftRecovery: {
        save: vi.fn().mockResolvedValue({ success: true }),
        remove: removeDraft,
      },
    }
    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.activeFileRelativePath = 'note.md'
    store.activeFilePath = '/notes/note.md'
    store.openedTextFileContents['note.md'] = createTextState('saved')
    store.setActiveFileContent('first draft', 'note.md')
    const firstRevision = store.openedTextFileContents['note.md'].recoveryRevision

    const saving = store.saveActiveFileContent('first draft', 'note.md')
    store.setActiveFileContent('newer draft', 'note.md')
    const newerRevision = store.openedTextFileContents['note.md'].recoveryRevision
    finishWrite({ success: true })
    await saving

    expect(store.openedTextFileContents['note.md'].content).toBe('newer draft')
    expect(store.openedTextFileContents['note.md'].loadedContent).toBe('first draft')
    expect(newerRevision).not.toBe(firstRevision)
    expect(removeDraft).toHaveBeenCalledWith(workspace.id, 'note.md', firstRevision)
  })

  it('continues the original-file save when recovery persistence rejects', async () => {
    const writeMarkdown = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).electronAPI = {
      file: { writeMarkdown },
      draftRecovery: {
        save: vi.fn().mockRejectedValue(new Error('disk full')),
        remove: vi.fn().mockResolvedValue({ success: true }),
      },
    }
    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.activeFileRelativePath = 'note.md'
    store.activeFilePath = '/notes/note.md'
    store.openedTextFileContents['note.md'] = createTextState('saved')
    store.setActiveFileContent('draft', 'note.md')

    const result = await store.saveActiveFileContent('draft', 'note.md')

    expect(result.success).toBe(true)
    expect(writeMarkdown).toHaveBeenCalledWith('/notes/note.md', 'draft', 'saved')
    expect(store.openedTextFileContents['note.md'].isSaving).toBe(false)
  })

  it('requires confirmation before a recovered conflict can overwrite external changes', async () => {
    const writeMarkdown = vi.fn()
    ;(window as any).electronAPI = {
      app: { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      file: { writeMarkdown },
      draftRecovery: {
        save: vi.fn().mockResolvedValue({ success: true }),
        remove: vi.fn().mockResolvedValue({ success: true }),
      },
    }
    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.activeFileRelativePath = 'note.md'
    store.activeFilePath = '/notes/note.md'
    store.openedTextFileContents['note.md'] = {
      ...createTextState('external change'),
      content: 'recovered draft',
      recoveryRevision: 'recovered-revision',
      recoveryConflict: true,
    }

    const result = await store.saveActiveFileContent('recovered draft', 'note.md')

    expect(result.success).toBe(false)
    expect(writeMarkdown).not.toHaveBeenCalled()
    expect(store.isFileDirty('note.md')).toBe(true)
  })

  it('migrates a dirty recovery draft when its open file is renamed', async () => {
    const saveDraft = vi.fn().mockResolvedValue({ success: true })
    const movePaths = vi.fn().mockResolvedValue({ success: true, data: 1 })
    ;(window as any).electronAPI = {
      draftRecovery: {
        save: saveDraft,
        movePaths,
        remove: vi.fn().mockResolvedValue({ success: true }),
      },
    }
    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.openedTextFileContents['old/note.md'] = {
      ...createTextState('saved'),
      content: 'draft',
      recoveryRevision: 'revision-1',
    }

    store.syncOpenedFilesAfterMove([{ from: 'old', to: 'new' }])
    await store.migrateDraftRecoveryAfterMove([{ from: 'old', to: 'new' }])

    expect(movePaths).toHaveBeenCalledWith(workspace.id, [{ from: 'old', to: 'new' }])
    expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({ relativePath: 'new/note.md', draftContent: 'draft' }))
  })

  it('removes the matching recovery revision after a file is deleted', async () => {
    const removeDraft = vi.fn().mockResolvedValue({ success: true, data: true })
    ;(window as any).electronAPI = {
      draftRecovery: { removePaths: removeDraft },
    }
    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.openedTextFileContents['folder/note.md'] = {
      ...createTextState('saved'),
      content: 'draft',
      recoveryRevision: 'revision-1',
    }

    await store.removeDraftRecoveryForPaths(['folder'])

    expect(removeDraft).toHaveBeenCalledWith(workspace.id, ['folder'])
  })
})
