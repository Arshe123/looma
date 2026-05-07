import { describe, expect, it, vi } from 'vitest'
import { executeRedoAction, executeUndoAction } from '../workspace-history-service'
import type { UndoAction } from '../workspace-types'

const ok = <T>(data?: T) => ({ success: true as const, data })

const createRuntime = () => {
  const setBusy = vi.fn()
  const createMarkdown = vi.fn(async () => {})
  const api = {
    fs: {
      delete: vi.fn(async () => ok({ trashRelativePath: '.trash/1' })),
      move: vi.fn(async () => ok()),
      restore: vi.fn(async () => ok()),
    },
  }
  return {
    runtime: {
      workspaceId: 'ws1',
      api,
      setBusy,
      createMarkdown,
      pathBase: (p: string) => p.split('/').pop() || p,
    },
    setBusy,
    createMarkdown,
    api,
  }
}

describe('workspace history service', () => {
  it('executeUndoAction(create) returns delete action', async () => {
    const { runtime, setBusy, api } = createRuntime()
    const action: UndoAction = { type: 'create', relativePath: 'docs/a.md' }

    const result = await executeUndoAction(action, runtime)

    expect(api.fs.delete).toHaveBeenCalledWith('ws1', 'docs/a.md')
    expect(setBusy).toHaveBeenNthCalledWith(1, true, '删除中...')
    expect(setBusy).toHaveBeenNthCalledWith(2, false)
    expect(result).toEqual({
      type: 'delete',
      items: [{ trashRelativePath: '.trash/1', restoreTo: 'docs/a.md' }],
    })
  })

  it('executeRedoAction(move) returns reversed move action', async () => {
    const { runtime, api } = createRuntime()
    const action: UndoAction = { type: 'move', items: [{ from: 'a.md', to: 'archived/a.md' }] }

    const result = await executeRedoAction(action, runtime)

    expect(api.fs.move).toHaveBeenCalledWith('ws1', 'archived/a.md', 'a.md')
    expect(result).toEqual({ type: 'move', items: [{ from: 'archived/a.md', to: 'a.md' }] })
  })

  it('executeRedoAction(create) delegates to createMarkdown basename', async () => {
    const { runtime, createMarkdown } = createRuntime()
    const action: UndoAction = { type: 'create', relativePath: 'docs/new.md' }

    const result = await executeRedoAction(action, runtime)

    expect(createMarkdown).toHaveBeenCalledWith('new.md')
    expect(result).toBeNull()
  })
})
