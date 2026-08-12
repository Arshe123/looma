import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

const workspace = {
  id: 'workspace-1',
  name: 'Notes',
  path: 'E:\\notes',
  createdAt: 1,
  lastOpenedAt: 1,
}

describe('workspace startup hydration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as any).window = globalThis.window || globalThis
  })

  it('restores the sidebar and active note without waiting for AI history', async () => {
    const pendingAi = deferred<any>()
    ;(window as any).electronAPI = {
      workspaceMeta: {
        get: vi.fn().mockResolvedValue({
          success: true,
          data: {
            expandedDirs: [],
            selectedPaths: [],
            noteOrder: {},
            tabs: [{ id: 'file:note.md', kind: 'file', relativePath: 'note.md' }],
            activeTabId: 'file:note.md',
            activeFile: 'note.md',
            activeSidebarPanel: 'ai',
            fileSessions: {},
            outlineExpandedHeadingIds: {
              'file:note.md': ['heading-1'],
            },
            outlineExpansionStateVersion: 1,
          },
        }),
        set: vi.fn().mockResolvedValue({ success: true }),
      },
      workspaceAi: {
        get: vi.fn(() => pendingAi.promise),
        set: vi.fn().mockResolvedValue({ success: true }),
      },
      file: {
        readMarkdown: vi.fn().mockResolvedValue({ success: true, data: '# Note' }),
      },
    }

    const store = useWorkspaceStore()
    store.workspaces = [workspace]
    store.activeWorkspaceId = workspace.id

    await store.loadWorkspaceMeta(workspace.id)

    expect(store.activeSidebarPanel).toBe('ai')
    expect(store.activeTabId).toBe('file:note.md')
    expect(store.activeFileRelativePath).toBe('note.md')
    expect(store.outlineExpandedHeadingIds).toEqual({
      'file:note.md': ['heading-1'],
    })
    expect(window.electronAPI.workspaceAi.get).toHaveBeenCalledWith(workspace.id)
  })

  it('ignores unversioned expansion state generated before explicit-toggle persistence', async () => {
    const pendingAi = deferred<any>()
    ;(window as any).electronAPI = {
      workspaceMeta: {
        get: vi.fn().mockResolvedValue({
          success: true,
          data: {
            expandedDirs: [],
            selectedPaths: [],
            noteOrder: {},
            outlineExpandedHeadingIds: {
              'system:help': [],
            },
          },
        }),
        set: vi.fn().mockResolvedValue({ success: true }),
      },
      workspaceAi: {
        get: vi.fn(() => pendingAi.promise),
        set: vi.fn().mockResolvedValue({ success: true }),
      },
    }

    const store = useWorkspaceStore()
    store.activeWorkspaceId = workspace.id

    await store.loadWorkspaceMeta(workspace.id)

    expect(store.outlineExpandedHeadingIds).toEqual({})
  })

  it('persists heading expansion for each outline source', async () => {
    const setMeta = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).electronAPI = {
      workspaceMeta: { set: setMeta },
    }

    const store = useWorkspaceStore()
    store.activeWorkspaceId = workspace.id
    store.tabs = [{ id: 'file:note.md', kind: 'file', relativePath: 'note.md' }]
    store.activeTabId = 'file:note.md'

    store.setOutlineExpandedHeadingIds('file:note.md', ['heading-0', 'heading-2'])

    await vi.waitFor(() => {
      expect(setMeta).toHaveBeenCalledWith(
        workspace.id,
        expect.objectContaining({
          outlineExpandedHeadingIds: {
            'file:note.md': ['heading-0', 'heading-2'],
          },
        }),
      )
    })
  })

  it('tracks root directory loading separately from an empty directory', async () => {
    const pendingList = deferred<any>()
    ;(window as any).electronAPI = {
      fs: {
        listDir: vi.fn(() => pendingList.promise),
        watchAdd: vi.fn().mockResolvedValue({ success: true }),
      },
    }

    const store = useWorkspaceStore()
    store.activeWorkspaceId = workspace.id

    const loading = store.loadDir(workspace.id, '')
    expect(store.dirLoadStates['']).toBe('loading')
    expect(Object.prototype.hasOwnProperty.call(store.dirEntries, '')).toBe(false)

    pendingList.resolve({ success: true, data: [] })
    await loading

    expect(store.dirLoadStates['']).toBe('loaded')
    expect(store.dirEntries['']).toEqual([])
  })

  it('ignores a directory response from a workspace that is no longer active', async () => {
    const pendingList = deferred<any>()
    ;(window as any).electronAPI = {
      fs: {
        listDir: vi.fn(() => pendingList.promise),
        watchAdd: vi.fn().mockResolvedValue({ success: true }),
      },
    }

    const store = useWorkspaceStore()
    store.activeWorkspaceId = workspace.id
    const loading = store.loadDir(workspace.id, '')

    store.activeWorkspaceId = 'workspace-2'
    pendingList.resolve({ success: true, data: [{ name: 'stale.md', relativePath: 'stale.md', isDirectory: false, size: 0, mtimeMs: 0 }] })
    await loading

    expect(store.dirEntries['']).toBeUndefined()
  })
})
