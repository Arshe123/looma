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

describe('template-created Markdown integration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as any).window = globalThis.window || globalThis
  })

  it('records undo history, refreshes the target directory and opens the created file', async () => {
    const listDir = vi.fn().mockResolvedValue({ success: true, data: [] })
    ;(window as any).electronAPI = {
      fs: { listDir, watchAdd: vi.fn().mockResolvedValue({ success: true }) },
      workspaceMeta: { set: vi.fn().mockResolvedValue({ success: true }) },
    }

    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id

    await store.completeMarkdownCreation('journal/daily.md', 'journal')

    expect(store.undoStack[0]).toEqual({ type: 'create', relativePath: 'journal/daily.md' })
    expect(store.redoStack).toEqual([])
    expect(listDir).toHaveBeenCalledWith(workspace.id, 'journal')
    expect(store.activeFileRelativePath).toBe('journal/daily.md')
  })
})
