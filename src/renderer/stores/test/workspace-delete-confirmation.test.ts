import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

const setup = () => {
  const remove = vi.fn().mockResolvedValue({ success: true, data: { trashRelativePath: 'trash/note.md' } })
  ;(globalThis as any).window = globalThis.window || globalThis
  ;(window as any).electronAPI = {
    fs: { delete: remove, listDir: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    workspaceMeta: { set: vi.fn().mockResolvedValue({ success: true }) },
    draftRecovery: { removePaths: vi.fn().mockResolvedValue({ success: true, data: 0 }) },
  }
  const store = useWorkspaceStore()
  store.activeWorkspaceId = 'workspace-1'
  store.workspaces = [{ id: 'workspace-1', name: '笔记', path: '/notes', createdAt: 1, lastOpenedAt: 1 }]
  store.selectedPaths = ['notes/note.md']
  return { store, remove }
}

describe('file deletion confirmation', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('waits for confirmation and leaves files and selection intact on cancellation', async () => {
    const { store, remove } = setup()
    const deletion = store.deleteEntries(['notes/note.md'])
    expect(store.confirmationDialogOpen).toBe(true)
    expect(store.confirmationDialogTitle).toBe('确认删除？')
    expect(store.confirmationDialogMessage).toContain('notes/note.md')
    expect(store.confirmationDialogMessage).toContain('回收站')
    expect(store.confirmationDialogConfirmText).toBe('删除')
    expect(store.confirmationDialogDanger).toBe(true)
    expect(remove).not.toHaveBeenCalled()
    store.cancelConfirmation()
    await deletion
    expect(remove).not.toHaveBeenCalled()
    expect(store.selectedPaths).toEqual(['notes/note.md'])
    expect(store.undoStack).toEqual([])
    expect(store.isBusy).toBe(false)
  })

  it('deletes the captured multi-selection once after acceptance and retains undo history', async () => {
    const { store, remove } = setup()
    const paths = ['notes/note.md', 'folder']
    const deletion = store.deleteEntries(paths)
    expect(store.confirmationDialogMessage).toContain('2 个项目')
    expect(store.confirmationDialogMessage).toContain('所有内容')
    await store.deleteEntries(paths)
    expect(remove).not.toHaveBeenCalled()
    paths.splice(0, paths.length, 'other.md')
    store.acceptConfirmation()
    await deletion
    expect(remove.mock.calls).toEqual([
      ['workspace-1', 'notes/note.md'],
      ['workspace-1', 'folder'],
    ])
    expect(store.undoStack[0]).toEqual({ type: 'delete', items: [
      { trashRelativePath: 'trash/note.md', restoreTo: 'notes/note.md' },
      { trashRelativePath: 'trash/note.md', restoreTo: 'folder' },
    ] })
    expect(store.selectedPaths).toEqual([])
    expect(store.isBusy).toBe(false)
  })

  it('does not delete after switching workspaces during confirmation', async () => {
    const { store, remove } = setup()
    const deletion = store.deleteEntries(['notes/note.md'])
    store.activeWorkspaceId = 'workspace-2'
    store.acceptConfirmation()
    await deletion
    expect(remove).not.toHaveBeenCalled()
  })

  it('does not delete if another file operation became busy during confirmation', async () => {
    const { store, remove } = setup()
    const deletion = store.deleteEntries(['notes/note.md'])
    store.setBusy(true, '重命名中...')
    store.acceptConfirmation()
    await deletion
    expect(remove).not.toHaveBeenCalled()
    expect(store.isBusy).toBe(true)
  })
})
