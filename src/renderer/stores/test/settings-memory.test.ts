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
  vi.stubGlobal('window', { electronAPI: { appSettings: { get: service.getSettings, set: service.setSettings } } })
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
  vi.stubGlobal('window', { electronAPI: { appSettings: { set: mode === 'missing' ? undefined : async () => {
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
  expect((await service.setSettings(off)).success).toBe(true)
  await rm(file)
  await mkdir(file)
  expect((await service.setSettings(normalizeAppSettings({}))).success).toBe(false)
  expect(service.canAutoMaintainUserProfile()).toBe(false)
})
