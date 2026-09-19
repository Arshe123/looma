import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[], root: '', workspace: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.root },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) },
  BrowserWindow: { getAllWindows: () => mocks.windows }, dialog: { showMessageBox: vi.fn() },
}))
vi.mock('../../services/workspace/workspaceService', () => ({ workspaceService: {
  getState: async () => ({ success: true, data: { workspaces: [{ id: 'target', path: mocks.workspace }] } }),
  checkExists: async () => ({ success: true, data: { exists: true } }),
} }))
import { createOpenWithController } from '../externalDocumentsIpc'

function win(id: number, workspace = false) {
  return Object.assign(new EventEmitter(), {
    webContents: { id, send: vi.fn(), getURL: () => `file:///app.html?${workspace ? 'workspaceId=target' : 'editorOnly=1'}` },
    isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), focus: vi.fn(),
  })
}
const call = (name: string, owner: number, ...args: any[]) => mocks.handlers.get(`externalDocuments:${name}`)!({ sender: { id: owner } }, ...args)
let source: ReturnType<typeof win>
let target: ReturnType<typeof win>
let id: string
let create: ReturnType<typeof vi.fn<[], any>>
beforeEach(async () => {
  mocks.handlers.clear()
  mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-handoff-test-'))
  mocks.workspace = path.join(mocks.root, 'workspace')
  await fs.mkdir(mocks.workspace)
  const file = path.join(mocks.root, 'external.md')
  await fs.writeFile(file, 'disk')
  source = win(1); target = win(2, true)
  mocks.windows = [source, target]
  create = vi.fn(() => target as any)
  const controller = createOpenWithController(() => source as any, create)
  controller.register(source as any); controller.register(target as any)
  await call('ready', 1, null, [])
  await call('ready', 2, 'target', [])
  await controller.start()
  // Seed an external owner in source before a target is available for routing.
  mocks.windows = [source]
  await call('ready', 2, null, [])
  await call('ready', 1, null, [])
  source.emit('focus')
  controller.enqueue([file])
  await vi.waitFor(() => expect(source.webContents.send).toHaveBeenCalledWith('externalDocuments:open', expect.anything()))
  id = source.webContents.send.mock.calls.find(args => args[0] === 'externalDocuments:open')![1].document.id
  mocks.windows = [source, target]
  await call('ready', 2, 'target', [])
})
afterEach(async () => { vi.useRealTimers(); await fs.rm(mocks.root, { recursive: true, force: true }) })
async function transfer() {
  const result = call('transfer', 1, 'target', id, 'latest', 'disk').then(() => 'committed', (error: Error) => error.message)
  await vi.waitFor(() => expect(target.webContents.send).toHaveBeenCalledWith('externalDocuments:handoff', expect.anything()))
  const request = target.webContents.send.mock.calls.find(args => args[0] === 'externalDocuments:handoff')![1]
  return { result, request }
}
it('reuses the target and transfers exclusive authority only on its claim', async () => {
  const { result, request } = await transfer()
  expect(create).not.toHaveBeenCalled()
  expect(await call('readCurrent', 1, id)).toBe('disk')
  expect(() => call('claim', 1, request.token)).toThrow('失效')
  expect(await call('claim', 2, request.token)).toMatchObject({ content: 'latest', baseContent: 'disk' })
  expect(await result).toBe('committed')
  expect(() => call('readCurrent', 1, id)).toThrow('授权')
  expect(await call('readCurrent', 2, id)).toBe('disk')
})
it('a rejected target leaves source authority and the latest recovery draft intact', async () => {
  const { result, request } = await transfer()
  await call('claim', 2, request.token, 'target dirty')
  expect(await result).toBe('target dirty')
  expect(await call('readCurrent', 1, id)).toBe('disk')
  const names = await fs.readdir(path.join(mocks.root, 'external-document-drafts'))
  const draft = JSON.parse(await fs.readFile(path.join(mocks.root, 'external-document-drafts', names.find(name => name.endsWith('.json'))!), 'utf8'))
  expect(draft.content).toBe('latest')
})
it('target destruction cancels the transfer without relinquishing source ownership', async () => {
  const { result } = await transfer()
  target.emit('closed')
  expect(await result).toContain('关闭')
  expect(await call('readCurrent', 1, id)).toBe('disk')
})
it('a timed-out handoff cannot be claimed later', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { result, request } = await transfer()
  await vi.advanceTimersByTimeAsync(20001)
  expect(await result).toContain('及时')
  expect(() => call('claim', 2, request.token)).toThrow('失效')
  expect(await call('readCurrent', 1, id)).toBe('disk')
})
