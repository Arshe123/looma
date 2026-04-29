import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from './workspace'

const ok = <T>(data?: T) => ({ success: true as const, data })
const fail = (error: string) => ({ success: false as const, error })

const mockElectronAPI = () => {
  return {
    file: {
      readMarkdown: vi.fn(async () => ok('')),
      writeMarkdown: vi.fn(async () => ok()),
    },
    app: {
      onCommand: vi.fn(() => () => {}),
    },
    workspace: {
      selectDir: vi.fn(async () => null),
      getState: vi.fn(async () => ok({ workspaces: [], order: [], activeId: null })),
      list: vi.fn(async () => ok([])),
      create: vi.fn(async () => ok({ id: 'ws2', name: 'WS2', path: 'C:\\ws2' })),
      new: vi.fn(async () => ok({ id: 'wsNew', name: 'New', path: 'C:\\new' })),
      rename: vi.fn(async () => ok()),
      remove: vi.fn(async () => ok()),
      reorder: vi.fn(async () => ok()),
      setActive: vi.fn(async () => ok()),
    },
    workspaceMeta: {
      get: vi.fn(async () => ok({ expandedDirs: [], selectedPaths: [], noteOrder: {} })),
      set: vi.fn(async () => ok()),
    },
    fs: {
      listDir: vi.fn(async () => ok([])),
      rename: vi.fn(async () => ok()),
      createFolder: vi.fn(async () => ok('')),
      createFile: vi.fn(async () => ok('')),
      move: vi.fn(async () => ok()),
      delete: vi.fn(async () => ok({ trashRelativePath: '' })),
      restore: vi.fn(async () => ok()),
      watchStart: vi.fn(async () => ok()),
      watchStop: vi.fn(async () => ok()),
      onEvent: vi.fn(() => () => {}),
    },
    window: {
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onPrepareClose: vi.fn(() => () => {}),
    },
  }
}

describe('workspace store - single workspace switching', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const electronAPI = mockElectronAPI()
    ;(globalThis as any).window = {
      location: { search: '' },
      electronAPI,
      confirm: vi.fn(() => false),
    }
    ;(globalThis as any).localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {}),
    }
  })

  it('cancels switching when auto-save fails and user cancels', async () => {
    const store = useWorkspaceStore()
    const electronAPI = (globalThis as any).window.electronAPI

    store.workspaces = [
      { id: 'ws1', name: 'WS1', path: 'C:\\ws1', createdAt: 1, lastOpenedAt: 1 },
      { id: 'ws2', name: 'WS2', path: 'C:\\ws2', createdAt: 1, lastOpenedAt: 1 },
    ]
    store.activeWorkspaceId = 'ws1'
    store.watchedWorkspaceId = 'ws1'
    store.activeFilePath = 'C:\\ws1\\note.md'
    store.activeFileContent = 'changed'
    store.activeFileLoadedContent = 'original'

    electronAPI.file.writeMarkdown.mockResolvedValueOnce(fail('disk full'))
    ;(globalThis as any).window.confirm.mockReturnValueOnce(false)

    await store.switchWorkspace('ws2')

    expect(store.activeWorkspaceId).toBe('ws1')
    expect(electronAPI.fs.watchStop).not.toHaveBeenCalled()
  })

  it('switches workspace and stops previous watcher', async () => {
    const store = useWorkspaceStore()
    const electronAPI = (globalThis as any).window.electronAPI

    store.workspaces = [
      { id: 'ws1', name: 'WS1', path: 'C:\\ws1', createdAt: 1, lastOpenedAt: 1 },
      { id: 'ws2', name: 'WS2', path: 'C:\\ws2', createdAt: 1, lastOpenedAt: 1 },
    ]
    store.activeWorkspaceId = 'ws1'
    store.watchedWorkspaceId = 'ws1'
    store.activeFilePath = 'C:\\ws1\\note.md'
    store.activeFileContent = 'changed'
    store.activeFileLoadedContent = 'original'

    electronAPI.file.writeMarkdown.mockResolvedValueOnce(ok())

    await store.switchWorkspace('ws2')

    expect(electronAPI.fs.watchStop).toHaveBeenCalledWith('ws1')
    expect(electronAPI.workspace.setActive).toHaveBeenCalledWith('ws2')
    expect(electronAPI.fs.watchStart).toHaveBeenCalledWith('ws2')
    expect(store.activeWorkspaceId).toBe('ws2')
    expect(Object.keys(store.dirEntries).every((k) => k.startsWith('ws2:'))).toBe(true)
  })

  it('switchWorkspaceFlow selects dir, creates workspace and switches', async () => {
    const store = useWorkspaceStore()
    const electronAPI = (globalThis as any).window.electronAPI

    store.workspaces = [{ id: 'ws1', name: 'WS1', path: 'C:\\ws1', createdAt: 1, lastOpenedAt: 1 }]
    store.activeWorkspaceId = 'ws1'
    store.watchedWorkspaceId = 'ws1'

    electronAPI.workspace.selectDir.mockResolvedValueOnce('C:\\ws2')
    electronAPI.workspace.create.mockResolvedValueOnce(ok({ id: 'ws2', name: 'WS2', path: 'C:\\ws2' }))
    electronAPI.workspace.list.mockResolvedValueOnce(ok([
      { id: 'ws1', name: 'WS1', path: 'C:\\ws1', createdAt: 1, lastOpenedAt: 1 },
      { id: 'ws2', name: 'WS2', path: 'C:\\ws2', createdAt: 1, lastOpenedAt: 1 },
    ]))

    await store.switchWorkspaceFlow()

    expect(store.activeWorkspaceId).toBe('ws2')
  })

  it('newWorkspaceFlow creates via main process and switches', async () => {
    const store = useWorkspaceStore()
    const electronAPI = (globalThis as any).window.electronAPI

    electronAPI.workspace.selectDir.mockResolvedValueOnce('C:\\parent')
    ;(globalThis as any).window.confirm.mockReturnValueOnce(false)
    electronAPI.workspace.new.mockResolvedValueOnce(ok({ id: 'wsNew', name: 'New', path: 'C:\\parent\\New' }))
    electronAPI.workspace.list.mockResolvedValueOnce(ok([{ id: 'wsNew', name: 'New', path: 'C:\\parent\\New', createdAt: 1, lastOpenedAt: 1 }]))

    const p = store.newWorkspaceFlow()
    for (let i = 0; i < 10 && !store.inputDialogOpen; i += 1) {
      await Promise.resolve()
    }
    expect(store.inputDialogOpen).toBe(true)
    store.inputDialogValue = 'New'
    store.submitTextInput()
    await p

    expect(electronAPI.workspace.new).toHaveBeenCalled()
    expect(store.activeWorkspaceId).toBe('wsNew')
  })
})
