import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '../workspace'

const mockElectronApi = () => {
  const api = {
    fs: {
      delete: vi.fn(),
      restore: vi.fn(),
      move: vi.fn(),
      listDir: vi.fn().mockResolvedValue({ success: true, data: [] }),
      watchAdd: vi.fn().mockResolvedValue({ success: true }),
    },
    workspaceMeta: {
      set: vi.fn().mockResolvedValue({ success: true }),
    },
    file: {
      readMarkdown: vi.fn().mockResolvedValue({ success: true, data: 'restored content' }),
    },
  }

  ;(globalThis as any).window = {
    electronAPI: api,
    dispatchEvent: vi.fn(),
  }

  return api
}

describe('workspace store history synchronization', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('undoing a created active file closes its tab and records a restore redo action', async () => {
    const api = mockElectronApi()
    api.fs.delete.mockResolvedValue({
      success: true,
      data: { trashRelativePath: '1700000000000_new.md' },
    })
    const store = useWorkspaceStore()
    store.activeWorkspaceId = 'workspace-1'
    store.workspaces = [{ id: 'workspace-1', name: 'Workspace', path: 'E:/notes', createdAt: 1, lastOpenedAt: 1 }]
    store.openedFiles = ['notes/new.md']
    store.activeFileRelativePath = 'notes/new.md'
    store.activeFilePath = 'E:/notes/notes/new.md'
    store.activeFileContent = 'draft'
    store.activeFileLoadedContent = 'draft'
    store.undoStack = [{ type: 'create', relativePath: 'notes/new.md' }]

    await store.undo()

    expect(store.openedFiles).toEqual([])
    expect(store.activeFileRelativePath).toBe('')
    expect(store.activeFilePath).toBe('')
    expect(store.redoStack[0]).toEqual({
      type: 'restore',
      trashRelativePath: '1700000000000_new.md',
      restoreTo: 'notes/new.md',
    })
  })

  it('redoing an undone created markdown file restores it and reopens the tab', async () => {
    const api = mockElectronApi()
    api.fs.restore.mockResolvedValue({ success: true })
    const store = useWorkspaceStore()
    store.activeWorkspaceId = 'workspace-1'
    store.workspaces = [{ id: 'workspace-1', name: 'Workspace', path: 'E:/notes', createdAt: 1, lastOpenedAt: 1 }]
    store.redoStack = [
      { type: 'restore', trashRelativePath: '1700000000000_new.md', restoreTo: 'notes/new.md' } as any,
    ]

    await store.redo()

    expect(api.fs.restore).toHaveBeenCalledWith('workspace-1', '1700000000000_new.md', 'notes/new.md')
    expect(store.undoStack[0]).toEqual({ type: 'create', relativePath: 'notes/new.md' })
    expect(store.openedFiles).toEqual(['notes/new.md'])
    expect(store.activeFileRelativePath).toBe('notes/new.md')
  })

  it('redoing a delete closes tabs for removed files', async () => {
    const api = mockElectronApi()
    api.fs.delete.mockResolvedValue({
      success: true,
      data: { trashRelativePath: '1700000000000_old.md' },
    })
    const store = useWorkspaceStore()
    store.activeWorkspaceId = 'workspace-1'
    store.workspaces = [{ id: 'workspace-1', name: 'Workspace', path: 'E:/notes', createdAt: 1, lastOpenedAt: 1 }]
    store.openedFiles = ['notes/old.md', 'notes/keep.md']
    store.activeFileRelativePath = 'notes/old.md'
    store.activeFilePath = 'E:/notes/notes/old.md'
    store.redoStack = [{ type: 'delete', items: [{ trashRelativePath: 'old-trash.md', restoreTo: 'notes/old.md' }] }]

    await store.redo()

    expect(store.openedFiles).toEqual(['notes/keep.md'])
    expect(store.activeFileRelativePath).toBe('')
    expect(store.undoStack[0]).toEqual({
      type: 'delete',
      items: [{ trashRelativePath: '1700000000000_old.md', restoreTo: 'notes/old.md' }],
    })
  })

  it('undoing a move remaps opened tabs and active file paths', async () => {
    const api = mockElectronApi()
    api.fs.move.mockResolvedValue({ success: true })
    const store = useWorkspaceStore()
    store.activeWorkspaceId = 'workspace-1'
    store.workspaces = [{ id: 'workspace-1', name: 'Workspace', path: 'E:/notes', createdAt: 1, lastOpenedAt: 1 }]
    store.openedFiles = ['archive/a.md']
    store.activeFileRelativePath = 'archive/a.md'
    store.activeFilePath = 'E:/notes/archive/a.md'
    store.undoStack = [{ type: 'move', items: [{ from: 'notes/a.md', to: 'archive/a.md' }] }]

    await store.undo()

    expect(api.fs.move).toHaveBeenCalledWith('workspace-1', 'archive/a.md', 'notes/a.md')
    expect(store.openedFiles).toEqual(['notes/a.md'])
    expect(store.activeFileRelativePath).toBe('notes/a.md')
    expect(store.redoStack[0]).toEqual({
      type: 'move',
      items: [{ from: 'archive/a.md', to: 'notes/a.md' }],
    })
  })
})
