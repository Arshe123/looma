import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => void>(),
  quit: vi.fn(),
  prepare: vi.fn(),
  flush: vi.fn(),
  stop: vi.fn(async () => {}),
  initializeUpdate: vi.fn(),
  ready: vi.fn(),
}))
vi.mock('electron', () => ({
  app: {
    setAppUserModelId: vi.fn(), setName: vi.fn(), requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: mocks.ready }),
    on: (event: string, handler: (...args: any[]) => void) => mocks.listeners.set(event, handler),
    quit: mocks.quit,
  },
  BrowserWindow: { getAllWindows: () => [] }, Menu: {}, screen: {}, ipcMain: { handle: vi.fn() },
}))
vi.mock('../../workspace/workspaceService', () => ({ workspaceService: { getState: async () => ({ success: true, data: { workspaces: [] } }) } }))
vi.mock('../../workspace/workspaceAiService', () => ({ workspaceAiService: { flush: mocks.flush } }))
vi.mock('../../file/fileSystemService', () => ({ fileSystemService: {} }))
vi.mock('../../../ipc/agentIpc', () => ({ abortAllAgentRuns: vi.fn() }))
vi.mock('../../../ipc/workspaceIpc', () => ({ setWindowTitleForWorkspace: vi.fn() }))
vi.mock('../../rag/ragServiceProcess', () => ({ startBundledRagService: vi.fn(), stopBundledRagService: mocks.stop }))
vi.mock('../quitCoordinator', () => ({ prepareWindowsForQuit: mocks.prepare }))
vi.mock('../autoUpdate', () => ({ initializeAutoUpdateService: mocks.initializeUpdate }))
vi.mock('../../../ipc/externalDocumentsIpc', () => ({ createOpenWithController: () => ({ enqueue: vi.fn(), start: vi.fn(), hasPending: () => true }) }))
vi.mock('../../../ipc/appSettingsIpc', () => ({}))
vi.mock('../../../ipc/ragIpc', () => ({}))
vi.mock('../../../ipc/appIpc', () => ({}))
vi.mock('../../../ipc/fileIpc', () => ({}))
vi.mock('../../../ipc/fsIpc', () => ({}))
vi.mock('../../../ipc/ollamaIpc', () => ({}))
vi.mock('../../../ipc/noteTemplateIpc', () => ({}))

describe('main-process AI shutdown coordination', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })
  it('rejects update preparation when the user cancels close', async () => {
    mocks.prepare.mockResolvedValue(false)
    await import('../../../index')
    await mocks.ready.mock.calls[0][0]()
    const prepare = mocks.initializeUpdate.mock.calls[0][0]
    await expect(prepare()).rejects.toThrow('取消')
    expect(mocks.stop).not.toHaveBeenCalled()
  })
  it('cancels quit on a failed close preparation and allows retry', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('save failed')).mockResolvedValue(true)
    await import('../../../index')
    mocks.listeners.get('before-quit')!({ preventDefault: vi.fn() })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.quit).not.toHaveBeenCalled()
    mocks.listeners.get('before-quit')!({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce())
  })
  it('does not quit until renderer close and main-process draft drain have both completed', async () => {
    let windowsClosed!: () => void
    let drained!: () => void
    mocks.prepare.mockReturnValue(new Promise<boolean>(resolve => { windowsClosed = () => resolve(true) }))
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
