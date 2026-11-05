import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPinia } from 'pinia'
import { isProxy } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { createAppSettingsService } from '../../../main/services/app/appSettingsService'
import { aiProviders, type AiProvider } from '../../../shared/utils/app-settings'
import { useSettingsStore } from '../settings'

let directory = ''
afterEach(async () => {
  vi.unstubAllGlobals()
  if (directory) await rm(directory, { recursive: true, force: true })
})

it.each(['chat', 'embedding'] as const)('persists %s provider switches across the IPC clone boundary', async section => {
  directory = await mkdtemp(join(tmpdir(), 'looma-provider-switch-'))
  const file = join(directory, 'settings.json')
  const service = createAppSettingsService(file)
  const patch = vi.fn(async (value: unknown) => service.patchSettings(structuredClone(value)))
  vi.stubGlobal('window', { electronAPI: { appSettings: { get: service.getSettings, patch } } })
  const store = useSettingsStore(createPinia())
  await store.load()

  const configsKey = section === 'chat' ? 'chatProviderConfigs' : 'embeddingProviderConfigs'
  const switchProvider = async (provider: AiProvider) => {
    const current = store.aiSettings[section]
    const { provider: currentProvider, ...currentConfig } = current
    // Match the settings page's shallow copy: inactive entries are still Vue proxies.
    const configs = { ...store.aiSettings[configsKey], [currentProvider]: currentConfig }
    const nextConfig = configs[provider]
    await store.setAiSettings({
      [section]: { provider, ...nextConfig },
      [configsKey]: configs,
    })
    expect(store.lastError).toBe('')
    expect(store.aiSettings[section].provider).toBe(provider)
    const reloaded = (await createAppSettingsService(file).getSettings()).data!
    expect(reloaded.ai[section].provider).toBe(provider)
    expect(reloaded.ai[section].model).toBe(nextConfig.model)
  }

  expect(isProxy(store.aiSettings[configsKey].openai)).toBe(true)
  await switchProvider('openai')
  await store.setAiSettings({
    [section]: { ...store.aiSettings[section], model: 'fixture-saved-model', baseUrl: 'https://fixture.example.test/v1' },
  })
  expect(store.lastError).toBe('')
  for (const provider of aiProviders.filter(provider => provider !== 'openai')) {
    await switchProvider(provider)
  }
  await switchProvider('openai')
  expect(store.aiSettings[section].model).toBe('fixture-saved-model')
  expect(store.aiSettings[section].baseUrl).toBe('https://fixture.example.test/v1')
  expect(patch.mock.results.every(result => result.type === 'return')).toBe(true)
})
