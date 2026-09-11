import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createAppSettingsService } from '../../../main/services/app/appSettingsService'
import { useSettingsStore } from '../settings'

let directory = ''
afterEach(async () => {
  vi.unstubAllGlobals()
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('font preset persistence', () => {
  it('persists each preset through the real settings service and reloads it', async () => {
    directory = await mkdtemp(join(tmpdir(), 'looma-fonts-'))
    const service = createAppSettingsService(join(directory, 'settings.json'))
    vi.stubGlobal('window', { electronAPI: { appSettings: { get: () => service.getSettings(), set: (value: Parameters<typeof service.setSettings>[0]) => service.setSettings(value) } } })
    for (const preset of ['simple', 'literary', 'handwritten'] as const) {
      setActivePinia(createPinia())
      const store = useSettingsStore()
      await store.load()
      await store.setFontPreset(preset)
      expect(store.fontPreset).toBe(preset)
      setActivePinia(createPinia())
      const reloaded = useSettingsStore()
      await reloaded.load()
      expect(reloaded.fontPreset).toBe(preset)
      expect(reloaded.richTextZoom).toBe(store.richTextZoom)
    }
  })
})
