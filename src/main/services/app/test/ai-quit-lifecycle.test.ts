import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => void>(),
  quit: vi.fn(),
  prepare: vi.fn(),
  flush: vi.fn(),
  stop: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({
  app: {
    setAppUserModelId: vi.fn(), setName: vi.fn(), requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    on: (event: string, handler: (...args: any[]) => void) => mocks.listeners.set(event, handler),
    quit: mocks.quit,
  },
  BrowserWindow: { getAllWindows: () => [] }, Menu: {}, screen: {},
}))
vi.mock('../../workspace/workspaceService', () => ({ workspaceService: { getState: async () => ({ success: true, data: { workspaces: [] } }) } }))
vi.mock('../../workspace/workspaceAiService', () => ({ workspaceAiService: { flush: mocks.flush } }))
vi.mock('../../file/fileSystemService', () => ({ fileSystemService: {} }))
vi.mock('../../../ipc/agentIpc', () => ({ abortAllAgentRuns: vi.fn() }))
vi.mock('../../../ipc/workspaceIpc', () => ({ setWindowTitleForWorkspace: vi.fn() }))
vi.mock('../../rag/ragServiceProcess', () => ({ startBundledRagService: vi.fn(), stopBundledRagService: mocks.stop }))
vi.mock('../quitCoordinator', () => ({ prepareWindowsForQuit: mocks.prepare }))
vi.mock('../autoUpdate', () => ({ initializeAutoUpdateService: vi.fn() }))
vi.mock('../../../ipc/appSettingsIpc', () => ({}))
vi.mock('../../../ipc/ragIpc', () => ({}))
vi.mock('../../../ipc/appIpc', () => ({}))
vi.mock('../../../ipc/fileIpc', () => ({}))
vi.mock('../../../ipc/fsIpc', () => ({}))
vi.mock('../../../ipc/ollamaIpc', () => ({}))
vi.mock('../../../ipc/noteTemplateIpc', () => ({}))

describe('main-process AI shutdown coordination', () => {
  it('does not quit until renderer close and main-process draft drain have both completed', async () => {
    let windowsClosed!: () => void
    let drained!: () => void
    mocks.prepare.mockReturnValue(new Promise<void>(resolve => { windowsClosed = resolve }))
    mocks.flush.mockReturnValue(new Promise<void>(resolve => { drained = resolve }))
    await import('../../../index')
    const event = { preventDefault: vi.fn() }
    mocks.listeners.get('before-quit')!(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(mocks.flush).not.toHaveBeenCalled()
    expect(mocks.quit).not.toHaveBeenCalled()
    windowsClosed()
    await vi.waitFor(() => expect(mocks.flush).toHaveBeenCalledOnce())
    expect(mocks.quit).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
    // A repeated quit request must not start a second cleanup.
    mocks.listeners.get('before-quit')!(event)
    expect(mocks.prepare).toHaveBeenCalledOnce()
    drained()
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce())
    const finalEvent = { preventDefault: vi.fn() }
    mocks.listeners.get('before-quit')!(finalEvent)
    expect(finalEvent.preventDefault).not.toHaveBeenCalled()
  })
})
