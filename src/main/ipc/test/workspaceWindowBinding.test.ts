import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { beforeEach, expect, it, vi } from 'vitest'
import { getWindowWorkspace, registerWindowWorkspace } from '../../services/workspace/windowWorkspaceContext'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  setActive: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => state.handlers.set(name, fn) },
  app: {}, dialog: {}, BrowserWindow: {},
}))
vi.mock('../../index', () => ({ mainWindow: null }))
vi.mock('../windowIpc', () => ({ getWindowFromEvent: (event: any) => event.window }))
vi.mock('../../services/workspace/workspaceAiService', () => ({ workspaceAiService: {} }))
vi.mock('../../services/workspace/workspaceMetaService', () => ({ workspaceMetaService: {} }))
vi.mock('../../services/workspace/workspaceService', () => ({ workspaceService: {
  setActiveWorkspace: state.setActive,
  getState: async () => ({ success: true, data: { workspaces: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }] } }),
} }))
await import('../workspaceIpc')

function windowEvent() {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  return { sender: contents as unknown as WebContents, window: { setTitle: vi.fn() }, contents }
}
beforeEach(() => state.setActive.mockReset().mockResolvedValue({ success: true }))

it('updates only the requesting registered window after a validated workspace switch', async () => {
  const a = windowEvent(), b = windowEvent()
  registerWindowWorkspace(a.sender, 'A')
  registerWindowWorkspace(b.sender, 'B')
  const change = state.handlers.get('workspace:setActive')!
  expect((await change(a, 'B')).success).toBe(true)
  expect(getWindowWorkspace(a.sender)).toBe('B')
  expect(getWindowWorkspace(b.sender)).toBe('B')
  state.setActive.mockResolvedValueOnce({ success: false, error: 'not found' })
  expect((await change(a, 'forged')).success).toBe(false)
  expect(getWindowWorkspace(a.sender)).toBe('B')
  expect((await change(a, null)).success).toBe(true)
  expect(getWindowWorkspace(a.sender)).toBeNull()
  expect(getWindowWorkspace(b.sender)).toBe('B')
  const unknown = windowEvent()
  const calls = state.setActive.mock.calls.length
  expect((await change(unknown, 'A')).success).toBe(false)
  expect(state.setActive).toHaveBeenCalledTimes(calls)
  b.contents.emit('destroyed')
  expect(getWindowWorkspace(b.sender)).toBeUndefined()
  expect((await change(b, 'A')).success).toBe(false)
})

it('does not rebind a destroyed window when its pending switch finishes', async () => {
  const a = windowEvent()
  registerWindowWorkspace(a.sender, 'A')
  let finish!: (result: { success: boolean }) => void
  state.setActive.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = state.handlers.get('workspace:setActive')!(a, 'B')
  a.contents.emit('destroyed')
  finish({ success: true })
  expect((await pending).success).toBe(false)
  expect(getWindowWorkspace(a.sender)).toBeUndefined()
  expect(a.window.setTitle).not.toHaveBeenCalled()
})
