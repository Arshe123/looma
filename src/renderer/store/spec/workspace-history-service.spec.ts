import { describe, expect, it, vi } from 'vitest'
import { executeRedoAction, executeUndoAction } from '../workspace-history-service'

const createRuntime = () => {
  const setBusy = vi.fn()
  return {
    workspaceId: 'workspace-1',
    api: {
      fs: {
        delete: vi.fn(),
        restore: vi.fn(),
        move: vi.fn(),
      },
    },
    setBusy,
  }
}

describe('workspace history service', () => {
  it('undoes a create by deleting the path and returning a restore redo action', async () => {
    const runtime = createRuntime()
    runtime.api.fs.delete.mockResolvedValue({
      success: true,
      data: { trashRelativePath: '1700000000000_new.md' },
    })

    const result = await executeUndoAction({ type: 'create', relativePath: 'notes/new.md' }, runtime)

    expect(runtime.api.fs.delete).toHaveBeenCalledWith('workspace-1', 'notes/new.md')
    expect(result?.action).toEqual({
      type: 'restore',
      trashRelativePath: '1700000000000_new.md',
      restoreTo: 'notes/new.md',
    })
    expect(result?.effects.removedPaths).toEqual(['notes/new.md'])
    expect(result?.effects.affectedDirs).toEqual(['notes'])
  })

  it('redoes an undone create by restoring from trash and returning a create undo action', async () => {
    const runtime = createRuntime()
    runtime.api.fs.restore.mockResolvedValue({ success: true })

    const result = await executeRedoAction(
      { type: 'restore', trashRelativePath: '1700000000000_new.md', restoreTo: 'notes/new.md' },
      runtime,
    )

    expect(runtime.api.fs.restore).toHaveBeenCalledWith(
      'workspace-1',
      '1700000000000_new.md',
      'notes/new.md',
    )
    expect(result?.action).toEqual({ type: 'create', relativePath: 'notes/new.md' })
    expect(result?.effects.restoredPaths).toEqual(['notes/new.md'])
    expect(result?.effects.affectedDirs).toEqual(['notes'])
  })

  it('keeps move undo and redo symmetric', async () => {
    const runtime = createRuntime()
    runtime.api.fs.move.mockResolvedValue({ success: true })

    const result = await executeUndoAction(
      { type: 'move', items: [{ from: 'notes/a.md', to: 'archive/a.md' }] },
      runtime,
    )

    expect(runtime.api.fs.move).toHaveBeenCalledWith('workspace-1', 'archive/a.md', 'notes/a.md')
    expect(result?.action).toEqual({
      type: 'move',
      items: [{ from: 'archive/a.md', to: 'notes/a.md' }],
    })
    expect(result?.effects.movedItems).toEqual([{ from: 'archive/a.md', to: 'notes/a.md' }])
    expect(result?.effects.affectedDirs).toEqual(['archive', 'notes'])
  })
})
