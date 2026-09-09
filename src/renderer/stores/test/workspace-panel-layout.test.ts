import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

describe('independent workspace panels', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('window', { electronAPI: { workspaceMeta: { set: vi.fn().mockResolvedValue({ success: true }) } } })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('opens AI without replacing the file tree, and toggles either side independently', () => {
    const store = useWorkspaceStore()
    expect(store.fileSidebarOpen).toBe(true)
    expect(store.activeAuxiliaryPanel).toBe(null)
    store.toggleSidebarPanel('ai')
    expect(store.fileSidebarOpen).toBe(true)
    expect(store.activeAuxiliaryPanel).toBe('ai')
    store.toggleSidebarPanel('files')
    expect(store.fileSidebarOpen).toBe(false)
    expect(store.activeAuxiliaryPanel).toBe('ai')
    store.toggleSidebarPanel('outline')
    expect(store.activeAuxiliaryPanel).toBe('outline')
    store.toggleSidebarPanel('outline')
    expect(store.activeAuxiliaryPanel).toBe(null)
    expect(store.fileSidebarOpen).toBe(false)
  })

  it.each([
    [{ activeSidebarPanel: 'files' }, true, null],
    [{ activeSidebarPanel: 'ai' }, true, 'ai'],
    [{ activeSidebarPanel: 'outline' }, true, 'outline'],
    [{ activeSidebarPanel: null }, false, null],
    [{}, true, null],
    [{ activeSidebarPanel: 'ai', fileSidebarOpen: false, activeAuxiliaryPanel: null }, false, null],
  ])('restores legacy and explicit layout fields: %j', async (meta, files, auxiliary) => {
    const store = useWorkspaceStore()
    vi.spyOn(store, 'loadAiAssistantState').mockResolvedValue()
    window.electronAPI.workspaceMeta.get = vi.fn().mockResolvedValue({ success: true, data: meta })
    await store.loadWorkspaceMeta('test')
    expect(store.fileSidebarOpen).toBe(files)
    expect(store.activeAuxiliaryPanel).toBe(auxiliary)
  })

  it('persists both sides and keeps history navigation independent', async () => {
    const store = useWorkspaceStore()
    store.activeWorkspaceId = 'test'
    store.setActiveSidebarPanel('ai')
    expect(store.fileSidebarOpen).toBe(true)
    await store.saveWorkspaceMeta()
    expect(window.electronAPI.workspaceMeta.set).toHaveBeenLastCalledWith('test', expect.objectContaining({
      fileSidebarOpen: true, activeAuxiliaryPanel: 'ai',
    }))
    store.setFileSidebarOpen(false)
    store.setActiveAuxiliaryPanel('outline')
    await store.saveWorkspaceMeta()
    expect(window.electronAPI.workspaceMeta.set).toHaveBeenLastCalledWith('test', expect.objectContaining({
      fileSidebarOpen: false, activeAuxiliaryPanel: 'outline',
    }))
  })

  it('selects a theme explicitly and follows system changes only in system mode', () => {
    const store = useWorkspaceStore()
    const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    window.matchMedia = vi.fn().mockReturnValue(media)
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { setItem })
    store.setTheme('system')
    expect(store.resolvedTheme).toBe('dark')
    expect(media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    store.setTheme('light')
    expect(store.resolvedTheme).toBe('light')
    expect(media.removeEventListener).toHaveBeenCalled()
    expect(setItem).toHaveBeenLastCalledWith('theme', 'light')
  })
})
