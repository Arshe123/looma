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

describe('workspace rename state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as any).window = globalThis.window || globalThis
  })

  it('remaps selected and expanded paths after renaming a directory', async () => {
    const rename = vi.fn().mockResolvedValue({ success: true, data: 'new' })
    const listDir = vi.fn().mockResolvedValue({ success: true, data: [] })
    const setMeta = vi.fn().mockResolvedValue({ success: true })
    const movePaths = vi.fn().mockResolvedValue({ success: true, data: 0 })
    ;(window as any).electronAPI = {
      fs: { rename, listDir, watchAdd: vi.fn().mockResolvedValue({ success: true }) },
      workspaceMeta: { set: setMeta },
      draftRecovery: { movePaths },
    }

    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.selectedPaths = ['old/note.md']
    store.expandedDirs = ['old', 'old/nested']

    await store.renameEntry('old', 'new')

    expect(rename).toHaveBeenCalledWith(workspace.id, 'old', 'new')
    expect(store.selectedPaths).toEqual(['new/note.md'])
    expect(store.expandedDirs).toEqual(['new', 'new/nested'])
    expect(movePaths).toHaveBeenCalledWith(workspace.id, [{ from: 'old', to: 'new' }])
    expect(listDir).toHaveBeenCalledWith(workspace.id, '.')
    expect(listDir).toHaveBeenCalledWith(workspace.id, 'new')
    expect(listDir).toHaveBeenCalledWith(workspace.id, 'new/nested')
    expect(store.undoStack[0]).toEqual({ type: 'move', items: [{ from: 'old', to: 'new' }] })
    expect(store.isBusy).toBe(false)
    expect(setMeta).toHaveBeenCalled()
  })

  it('ignores deletion while a rename operation is in progress', async () => {
    let finishRename!: (result: { success: true; data: string }) => void
    const rename = vi.fn(() => new Promise<{ success: true; data: string }>((resolve) => { finishRename = resolve }))
    const deleteEntry = vi.fn()
    ;(window as any).electronAPI = {
      fs: {
        rename,
        delete: deleteEntry,
        listDir: vi.fn().mockResolvedValue({ success: true, data: [] }),
        watchAdd: vi.fn().mockResolvedValue({ success: true }),
      },
      workspaceMeta: { set: vi.fn().mockResolvedValue({ success: true }) },
      draftRecovery: { movePaths: vi.fn().mockResolvedValue({ success: true, data: 0 }) },
    }

    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.selectedPaths = ['old.md']

    const renaming = store.renameEntry('old.md', 'new.md')
    expect(store.isBusy).toBe(true)
    await store.deleteEntries(['old.md'])
    expect(deleteEntry).not.toHaveBeenCalled()

    finishRename({ success: true, data: 'new.md' })
    await renaming

    expect(store.selectedPaths).toEqual(['new.md'])
    expect(store.isBusy).toBe(false)
  })

  it('cleans stale selection when deletion reports ENOENT', async () => {
    const setMeta = vi.fn().mockResolvedValue({ success: true })
    const listDir = vi.fn().mockResolvedValue({ success: true, data: [] })
    ;(window as any).electronAPI = {
      fs: {
        delete: vi.fn().mockResolvedValue({ success: false, error: 'missing', errorCode: 'ENOENT' }),
        listDir,
        watchAdd: vi.fn().mockResolvedValue({ success: true }),
      },
      workspaceMeta: { set: setMeta },
      draftRecovery: { removePaths: vi.fn().mockResolvedValue({ success: true, data: 0 }) },
    }

    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id
    store.selectedPaths = ['old/note.md']

    await store.deleteEntries(['old/note.md'])

    expect(store.selectedPaths).toEqual([])
    expect(store.lastError).toBe('')
    expect(listDir).toHaveBeenCalledWith(workspace.id, 'old')
    expect(setMeta).toHaveBeenCalled()
  })
})
