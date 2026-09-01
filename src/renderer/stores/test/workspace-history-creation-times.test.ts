import { describe, expect, it, vi } from 'vitest'
import { executeRedoAction, executeUndoAction } from '../workspace-history-service'

const runtime = (api: any) => ({
  workspaceId: 'workspace-1',
  api,
  setBusy: vi.fn(),
})

describe('workspace history trash identity', () => {
  it('includes the trash id when undo restores a deleted item', async () => {
    const api = {
      fs: { restore: vi.fn().mockResolvedValue({ success: true }) },
    }

    const result = await executeUndoAction({
      type: 'delete',
      items: [{ trashRelativePath: 'trash-1', restoreTo: 'note.md' }],
    }, runtime(api))

    expect(result?.effects.restoredItems).toEqual([
      { trashRelativePath: 'trash-1', restoreTo: 'note.md' },
    ])
  })

  it('includes the new trash id when redo deletes the item again', async () => {
    const api = {
      fs: { delete: vi.fn().mockResolvedValue({ success: true, data: { trashRelativePath: 'trash-2' } }) },
    }

    const result = await executeRedoAction({
      type: 'delete',
      items: [{ trashRelativePath: 'trash-1', restoreTo: 'note.md' }],
    }, runtime(api))

    expect(result?.effects.trashedItems).toEqual([
      { trashRelativePath: 'trash-2', restoreTo: 'note.md' },
    ])
  })
})
