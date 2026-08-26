import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

const workspace = {
  id: 'workspace-1',
  name: 'Notes',
  path: 'E:\\notes',
  createdAt: 1,
  lastOpenedAt: 1,
}

describe('workspace large note loading', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as any).window = globalThis.window || globalThis
  })

  it('keeps a partial note clean and completes it from returned byte offsets', async () => {
    const readTextChunk = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        data: { content: '# first\n', offset: 0, nextOffset: 8, totalBytes: 600_000, done: false },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { content: 'second\n', offset: 8, nextOffset: 15, totalBytes: 600_000, done: true },
      })
    ;(window as any).electronAPI = { file: { readTextChunk } }

    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.activeFileRelativePath = 'large.md'
    store.activeFilePath = 'E:\\notes\\large.md'

    await store.loadTextFileContent('large.md')

    expect(store.openedTextFileContents['large.md']).toMatchObject({
      content: '# first\n',
      loadedContent: '',
      isPartial: true,
      nextOffset: 8,
      useChunkedPreview: true,
    })
    expect(store.isFileDirty('large.md')).toBe(false)

    await store.loadNextTextFileChunk('large.md')

    expect(readTextChunk).toHaveBeenLastCalledWith('E:\\notes\\large.md', 8, 256 * 1024)
    expect(store.openedTextFileContents['large.md']).toMatchObject({
      content: '# first\nsecond\n',
      loadedContent: '# first\nsecond\n',
      isPartial: false,
      nextOffset: 15,
    })

    await store.loadTextFileContent('large.md')
    expect(readTextChunk).toHaveBeenCalledTimes(2)
  })

  it('refreshes a clean cached note only after a filesystem change event', async () => {
    let fsListener: ((payload: { workspaceId: string; event: string; relativePath: string; origin?: 'editor' | 'external' }) => void) | undefined
    const readTextChunk = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        data: { content: 'cached', offset: 0, nextOffset: 6, totalBytes: 6, done: true },
      })
    const readMarkdown = vi.fn().mockResolvedValue({ success: true, data: 'changed on disk' })
    ;(window as any).electronAPI = {
      file: { readTextChunk, readMarkdown },
      fs: {
        onEvent: vi.fn((listener) => {
          fsListener = listener
          return vi.fn()
        }),
      },
    }

    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.activeFileRelativePath = 'note.md'
    store.activeFilePath = 'E:\\notes\\note.md'
    await store.loadTextFileContent('note.md')
    await store.loadTextFileContent('note.md')
    expect(readTextChunk).toHaveBeenCalledTimes(1)

    store.attachFsEvents()
    fsListener?.({ workspaceId: workspace.id, event: 'change', relativePath: 'note.md' })
    await vi.waitFor(() => {
      expect(readTextChunk).toHaveBeenCalledTimes(1)
      expect(readMarkdown).toHaveBeenCalledTimes(1)
      expect(store.openedTextFileContents['note.md'].content).toBe('changed on disk')
    })
  })

  it('keeps the open note state intact for a change caused by the editor save', async () => {
    let fsListener: ((payload: { workspaceId: string; event: string; relativePath: string; origin?: 'editor' | 'external' }) => void) | undefined
    const readMarkdown = vi.fn()
    ;(window as any).electronAPI = {
      file: { readMarkdown },
      fs: {
        onEvent: vi.fn((listener) => {
          fsListener = listener
          return vi.fn()
        }),
      },
    }

    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.activeFileRelativePath = 'note.md'
    store.activeFilePath = 'E:\\notes\\note.md'
    store.openedTextFileContents['note.md'] = {
      content: 'saved content',
      loadedContent: 'saved content',
      isSaving: false,
      saveError: '',
      isPartial: false,
      isLoading: false,
      isLoadingMore: false,
      nextOffset: 13,
      totalBytes: 13,
      loadRequestId: 1,
      useChunkedPreview: false,
    }
    const stateBeforeEvent = store.openedTextFileContents['note.md']

    store.attachFsEvents()
    fsListener?.({
      workspaceId: workspace.id,
      event: 'change',
      relativePath: 'note.md',
      origin: 'editor',
    })

    await Promise.resolve()
    expect(readMarkdown).not.toHaveBeenCalled()
    expect(store.openedTextFileContents['note.md']).toBe(stateBeforeEvent)
  })

  it('keeps the current content visible until an external refresh completes', async () => {
    let fsListener: ((payload: { workspaceId: string; event: string; relativePath: string; origin?: 'editor' | 'external' }) => void) | undefined
    let resolveRead!: (value: any) => void
    const readMarkdown = vi.fn(() => new Promise(resolve => { resolveRead = resolve }))
    ;(window as any).electronAPI = {
      file: { readMarkdown },
      fs: {
        onEvent: vi.fn((listener) => {
          fsListener = listener
          return vi.fn()
        }),
      },
    }

    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.activeFileRelativePath = 'note.md'
    store.activeFilePath = 'E:\\notes\\note.md'
    store.openedTextFileContents['note.md'] = {
      content: 'visible content',
      loadedContent: 'visible content',
      isSaving: false,
      saveError: '',
      isPartial: false,
      isLoading: false,
      isLoadingMore: false,
      nextOffset: 15,
      totalBytes: 15,
      loadRequestId: 1,
      useChunkedPreview: false,
    }

    store.attachFsEvents()
    fsListener?.({
      workspaceId: workspace.id,
      event: 'change',
      relativePath: 'note.md',
      origin: 'external',
    })

    expect(store.openedTextFileContents['note.md'].content).toBe('visible content')
    resolveRead({ success: true, data: 'changed externally' })
    await vi.waitFor(() => {
      expect(store.openedTextFileContents['note.md'].content).toBe('changed externally')
    })
  })

  it('marks a visible conflict instead of silently ignoring an external change while dirty', async () => {
    let fsListener: ((payload: { workspaceId: string; event: string; relativePath: string; origin?: 'editor' | 'external' }) => void) | undefined
    const readMarkdown = vi.fn().mockResolvedValue({ success: true, data: 'other window content' })
    ;(window as any).electronAPI = {
      file: { readMarkdown },
      fs: { onEvent: vi.fn((listener) => { fsListener = listener; return vi.fn() }) },
    }
    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.activeFileRelativePath = 'note.md'
    store.activeFilePath = 'E:\\notes\\note.md'
    store.openedTextFileContents['note.md'] = {
      content: 'local draft',
      loadedContent: 'saved content',
      isSaving: false,
      saveError: '',
      isPartial: false,
      isLoading: false,
      isLoadingMore: false,
      nextOffset: 13,
      totalBytes: 13,
      loadRequestId: 1,
      useChunkedPreview: false,
    }

    store.attachFsEvents()
    fsListener?.({ workspaceId: workspace.id, event: 'change', relativePath: 'note.md', origin: 'external' })

    await vi.waitFor(() => {
      expect(readMarkdown).toHaveBeenCalledOnce()
      expect(store.openedTextFileContents['note.md']).toMatchObject({
        content: 'local draft',
        loadedContent: 'saved content',
        recoveryConflict: true,
      })
    })
    expect(store.openedTextFileContents['note.md'].saveError).toContain('另一个窗口')
  })

  it('protects a rich-text keystroke before its debounced Markdown serialization finishes', async () => {
    let fsListener: ((payload: { workspaceId: string; event: string; relativePath: string; origin?: 'editor' | 'external' }) => void) | undefined
    const readMarkdown = vi.fn().mockResolvedValue({ success: true, data: 'other window content' })
    ;(window as any).electronAPI = {
      file: { readMarkdown },
      fs: { onEvent: vi.fn((listener) => { fsListener = listener; return vi.fn() }) },
    }
    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.activeFileRelativePath = 'note.md'
    store.activeFilePath = 'E:\\notes\\note.md'
    store.openedTextFileContents['note.md'] = {
      content: 'saved content',
      loadedContent: 'saved content',
      isSaving: false,
      saveError: '',
      hasPendingEditorChanges: true,
      isPartial: false,
      isLoading: false,
      isLoadingMore: false,
      nextOffset: 13,
      totalBytes: 13,
      loadRequestId: 1,
      useChunkedPreview: false,
    }

    store.attachFsEvents()
    fsListener?.({ workspaceId: workspace.id, event: 'change', relativePath: 'note.md', origin: 'external' })

    await vi.waitFor(() => {
      expect(readMarkdown).toHaveBeenCalledOnce()
      expect(store.openedTextFileContents['note.md']).toMatchObject({
        content: 'saved content',
        loadedContent: 'saved content',
        hasPendingEditorChanges: true,
        recoveryConflict: true,
      })
    })
  })

  it('replays an external refresh that arrives while the note is saving', async () => {
    let fsListener: ((payload: { workspaceId: string; event: string; relativePath: string; origin?: 'editor' | 'external' }) => void) | undefined
    let finishWrite!: (result: { success: true }) => void
    const writePromise = new Promise<{ success: true }>((resolve) => { finishWrite = resolve })
    const readMarkdown = vi.fn().mockResolvedValue({ success: true, data: 'newer disk content' })
    ;(window as any).electronAPI = {
      file: { writeMarkdown: vi.fn(() => writePromise), readMarkdown },
      fs: { onEvent: vi.fn((listener) => { fsListener = listener; return vi.fn() }) },
      draftRecovery: {
        save: vi.fn().mockResolvedValue({ success: true }),
        remove: vi.fn().mockResolvedValue({ success: true }),
      },
    }
    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.activeFileRelativePath = 'note.md'
    store.activeFilePath = 'E:\\notes\\note.md'
    store.openedTextFileContents['note.md'] = {
      content: 'local save',
      loadedContent: 'saved content',
      isSaving: false,
      saveError: '',
      isPartial: false,
      isLoading: false,
      isLoadingMore: false,
      nextOffset: 13,
      totalBytes: 13,
      loadRequestId: 1,
      useChunkedPreview: false,
    }
    store.attachFsEvents()

    const saving = store.saveActiveFileContent('local save', 'note.md')
    await vi.waitFor(() => expect(store.openedTextFileContents['note.md'].isSaving).toBe(true))
    fsListener?.({ workspaceId: workspace.id, event: 'change', relativePath: 'note.md', origin: 'external' })
    expect(readMarkdown).not.toHaveBeenCalled()
    finishWrite({ success: true })
    await saving

    expect(readMarkdown).toHaveBeenCalledOnce()
    expect(store.openedTextFileContents['note.md']).toMatchObject({
      content: 'newer disk content',
      loadedContent: 'newer disk content',
      isSaving: false,
    })
  })

  it('discards an initial chunk after the workspace changes', async () => {
    let resolveChunk!: (value: any) => void
    const pendingChunk = new Promise(resolve => { resolveChunk = resolve })
    ;(window as any).electronAPI = { file: { readTextChunk: vi.fn(() => pendingChunk) } }

    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    const loading = store.loadTextFileContent('large.md')

    store.activeWorkspaceId = 'workspace-2'
    resolveChunk({
      success: true,
      data: { content: 'stale', offset: 0, nextOffset: 5, totalBytes: 10, done: false },
    })
    await loading

    expect(store.openedTextFileContents['large.md']?.content).toBe('')
  })

  it('does not reload already loaded parent directories while revealing a cached tab', async () => {
    const listDir = vi.fn().mockResolvedValue({ success: true, data: [] })
    ;(window as any).electronAPI = {
      fs: { listDir, watchAdd: vi.fn().mockResolvedValue({ success: true }) },
      workspaceMeta: { set: vi.fn().mockResolvedValue({ success: true }) },
    }

    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.expandedDirs = ['docs', 'docs/nested']
    store.dirLoadStates = { docs: 'loaded', 'docs/nested': 'loaded' }
    store.dirEntries = { docs: [], 'docs/nested': [] }

    await store.ensureFileParentDirsExpanded('docs/nested/note.md')

    expect(listDir).not.toHaveBeenCalled()
  })
})
