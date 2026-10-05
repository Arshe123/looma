import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createAppSettingsService } from '../../../main/services/app/appSettingsService'
import { normalizeAppSettings } from '../../../shared/utils/app-settings'
import { useSettingsStore } from '../settings'

let directory = ''
afterEach(async () => {
  vi.unstubAllGlobals()
  if (directory) await rm(directory, { recursive: true, force: true })
})
it('defaults legacy settings to ON and persists OFF across service and renderer restart', async () => {
  expect(normalizeAppSettings({}).memory.autoMaintainUserProfile).toBe(true)
  expect(normalizeAppSettings({ memory: { autoMaintainUserProfile: 'false' } }).memory.autoMaintainUserProfile).toBe(true)
  directory = await mkdtemp(join(tmpdir(), 'looma-memory-settings-'))
  const file = join(directory, 'settings.json')
  await writeFile(file, '{}')
  const service = createAppSettingsService(file)
  vi.stubGlobal('window', { electronAPI: { appSettings: { get: service.getSettings, patch: service.patchSettings, onChanged: service.subscribe } } })
  setActivePinia(createPinia())
  const store = useSettingsStore()
  await store.load()
  expect(store.autoMaintainUserProfile).toBe(true)
  expect(await store.setAutoMaintainUserProfile(false)).toBe(true)
  const restarted = createAppSettingsService(file)
  expect((await restarted.getSettings()).data?.memory.autoMaintainUserProfile).toBe(false)
  expect(restarted.canAutoMaintainUserProfile()).toBe(false)
  await store.load()
  expect(store.autoMaintainUserProfile).toBe(false)
  expect(await store.setAutoMaintainUserProfile(true)).toBe(true)
  expect(service.canAutoMaintainUserProfile()).toBe(true)
})
it.each(['failure', 'throw', 'missing'])('retains the confirmed value on %s and reports failure', async mode => {
  setActivePinia(createPinia())
  vi.stubGlobal('window', { electronAPI: { appSettings: { patch: mode === 'missing' ? undefined : async () => {
    if (mode === 'throw') throw new Error('offline')
    return { success: false, error: '保存失败' }
  } } } })
  const store = useSettingsStore()
  expect(await store.setAutoMaintainUserProfile(false)).toBe(false)
  expect(store.autoMaintainUserProfile).toBe(true)
  expect(store.lastError).not.toBe('')
})
it('fails closed on unreadable settings and retains live authorization after failed persistence', async () => {
  directory = await mkdtemp(join(tmpdir(), 'looma-memory-failure-'))
  const file = join(directory, 'settings.json')
  await writeFile(file, 'broken')
  const service = createAppSettingsService(file)
  expect((await service.getSettings()).success).toBe(false)
  expect(service.canAutoMaintainUserProfile()).toBe(false)
  await rm(file)
  const off = normalizeAppSettings({ memory: { autoMaintainUserProfile: false } })
  expect((await service.patchSettings({ memory: off.memory })).success).toBe(true)
  await rm(file)
  await mkdir(file)
  expect((await service.patchSettings({ memory: { autoMaintainUserProfile: true } })).success).toBe(false)
  expect(service.canAutoMaintainUserProfile()).toBe(false)
})
it('synchronizes windows and unrelated stale edits cannot change memory permission', async () => {
  directory = await mkdtemp(join(tmpdir(), 'looma-settings-windows-'))
  const service = createAppSettingsService(join(directory, 'settings.json'))
  vi.stubGlobal('window', { electronAPI: { appSettings: { get: service.getSettings, patch: service.patchSettings, onChanged: service.subscribe } } })
  const a = useSettingsStore(createPinia())
  const b = useSettingsStore(createPinia())
  await Promise.all([a.load(), b.load()])
  await a.setAutoMaintainUserProfile(false)
  await vi.waitFor(() => expect(b.autoMaintainUserProfile).toBe(false))
  b.settings.memory.autoMaintainUserProfile = true // old-window snapshot
  await b.setShowLineNumbers(false)
  expect(service.canAutoMaintainUserProfile()).toBe(false)
  await vi.waitFor(() => expect(a.showLineNumbers).toBe(false))
  a.stopSync()
  b.stopSync()
})
it('ignores a late toggle response after a newer notification and cleans up listeners', async () => {
  let notify!: (revision: number) => void
  let release!: (value: unknown) => void
  let revision = 1
  let enabled = true
  const unsubscribe = vi.fn()
  const onChanged = vi.fn((callback: (revision: number) => void) => { notify = callback; return unsubscribe })
  const get = async () => ({ success: true, data: normalizeAppSettings({ memory: { autoMaintainUserProfile: enabled } }), revision })
  vi.stubGlobal('window', { electronAPI: { appSettings: { get, onChanged, patch: () => new Promise(resolve => { release = resolve }) } } })
  const store = useSettingsStore(createPinia())
  await store.load()
  await store.load()
  expect(onChanged).toHaveBeenCalledTimes(1)
  const saving = store.setAutoMaintainUserProfile(false)
  expect(store.memorySettingsBusy).toBe(true)
  expect(store.autoMaintainUserProfile).toBe(true)
  revision = 3
  enabled = true
  notify(3)
  await vi.waitFor(() => expect(store.revision).toBe(3))
  release({ success: true, data: normalizeAppSettings({ memory: { autoMaintainUserProfile: false } }), revision: 2 })
  expect(await saving).toBe(true)
  expect(store.autoMaintainUserProfile).toBe(true)
  expect(store.memorySettingsBusy).toBe(false)
  store.stopSync()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})
it('rolls failed editor edits back to confirmed main state even if reconciliation fails', async () => {
  let readable = true
  vi.stubGlobal('window', { electronAPI: { appSettings: {
    get: async () => readable ? { success: true, data: normalizeAppSettings({}), revision: 1 } : { success: false },
    patch: async () => ({ success: false, error: 'disk full' }),
  } } })
  const store = useSettingsStore(createPinia())
  await store.load()
  readable = false
  await store.setShowLineNumbers(false)
  expect(store.showLineNumbers).toBe(true)
  expect(store.lastError).toBe('disk full')
})
it('rejects an old reply as soon as invalidated, before the refresh arrives', async () => {
  let notify!: (revision: number) => void
  let finishRead!: (value: unknown) => void
  let finishWrite!: (value: unknown) => void
  let reads = 0
  vi.stubGlobal('window', { electronAPI: { appSettings: {
    get: () => ++reads === 1 ? Promise.resolve({ success: true, data: normalizeAppSettings({}), revision: 1 }) : new Promise(resolve => { finishRead = resolve }),
    patch: () => new Promise(resolve => { finishWrite = resolve }),
    onChanged: (callback: (revision: number) => void) => { notify = callback; return () => {} },
  } } })
  const store = useSettingsStore(createPinia())
  await store.load()
  const saving = store.setAutoMaintainUserProfile(false)
  notify(3)
  finishWrite({ success: true, data: normalizeAppSettings({ memory: { autoMaintainUserProfile: false } }), revision: 2 })
  await saving
  expect(store.autoMaintainUserProfile).toBe(true)
  finishRead({ success: true, data: normalizeAppSettings({}), revision: 3 })
  await vi.waitFor(() => expect(store.revision).toBe(3))
  store.stopSync()
})
