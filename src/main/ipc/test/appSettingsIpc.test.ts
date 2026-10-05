import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const state = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: any[]) => any>(), send: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => state.root },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => state.handlers.set(name, handler) },
  BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: state.send } }] },
}))
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); vi.resetModules(); state.handlers.clear(); state.send.mockClear() })
it('broadcasts credential-free invalidation and rejects legacy unversioned snapshots at IPC', async () => {
  state.root = await mkdtemp(join(tmpdir(), 'settings-ipc-'))
  await import('../appSettingsIpc')
  const get = state.handlers.get('appSettings:get')!
  const patch = state.handlers.get('appSettings:patch')!
  const set = state.handlers.get('appSettings:set')!
  const stale = await get({})
  expect((await patch({}, { memory: { autoMaintainUserProfile: false } })).success).toBe(true)
  expect(state.send.mock.calls).toEqual([['appSettings:changed', stale.revision + 1]])
  expect((await set({}, stale.data)).success).toBe(false)
  expect((await set({}, stale.data, stale.revision)).success).toBe(false)
  expect((await get({})).data.memory.autoMaintainUserProfile).toBe(false)
  expect(state.send).toHaveBeenCalledTimes(1)
})
