import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createAppSettingsService } from '../appSettingsService'
import { getChatContextLimits, getChatContextWindowTokens } from '../../../../shared/utils/app-settings'

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })
it('rejects a stale full-window save instead of reenabling revoked authorization', async () => {
  root = await mkdtemp(join(tmpdir(), 'settings-race-'))
  const service = createAppSettingsService(join(root, 'settings.json'))
  const first = await service.getSettings()
  const a = first.data!
  const b = (await service.getSettings()).data!
  a.memory.autoMaintainUserProfile = false
  expect((await service.setSettings(a, first.revision)).success).toBe(true)
  b.editor.showLineNumbers = false
  expect((await service.setSettings(b, first.revision)).success).toBe(false)
  expect((await service.setSettings(b)).success).toBe(false)
  expect(service.canAutoMaintainUserProfile()).toBe(false)
})
it('merges concurrent independent fields and only notifies confirmed saves', async () => {
  root = await mkdtemp(join(tmpdir(), 'settings-patch-'))
  const service = createAppSettingsService(join(root, 'settings.json'))
  let changes = 0
  const stop = service.subscribe(() => { changes++ })
  await Promise.all([
    service.patchSettings({ memory: { autoMaintainUserProfile: false } }),
    service.patchSettings({ editor: { showLineNumbers: false } }),
    service.patchSettings({ editor: { richTextZoom: 125 } }),
  ])
  const settings = (await service.getSettings()).data!
  expect(settings.memory.autoMaintainUserProfile).toBe(false)
  expect(settings.editor.showLineNumbers).toBe(false)
  expect(settings.editor.richTextZoom).toBe(125)
  expect(changes).toBe(3)
  expect((await service.patchSettings({ memory: { autoMaintainUserProfile: 'true' } })).success).toBe(false)
  expect((await service.patchSettings(JSON.parse('{"__proto__": {"polluted": true}}'))).success).toBe(false)
  expect(changes).toBe(3)
  stop()
  await service.patchSettings({ memory: { autoMaintainUserProfile: true } })
  expect(changes).toBe(3)
})

it('persists model-scoped overrides independently of replacement discovery', async () => {
  root = await mkdtemp(join(tmpdir(), 'settings-context-'))
  const settingsPath = join(root, 'settings.json')
  const service = createAppSettingsService(settingsPath)
  const chat = (await service.getSettings()).data!.ai.chat
  const key = JSON.stringify([chat.provider, chat.baseUrl, chat.model])
  expect(getChatContextWindowTokens(chat)).toBe(262144)
  const patch = (value: unknown) => service.patchSettings(structuredClone({ ai: { chatModelContexts: { [key]: value } } }))
  for (const result of await Promise.all([
    patch({ discovered: { contextWindowTokens: 65536, maxInputTokens: 60000, maxOutputTokens: 4096 } }),
    patch({ overrideTokens: 50000 }),
  ])) expect(result.success).toBe(true)
  expect((await patch({ discovered: { contextWindowTokens: 32768, maxOutputTokens: 2048 } })).success).toBe(true)
  expect((await patch({ overrideTokens: 12.5 })).success).toBe(false)
  const restored = (await createAppSettingsService(settingsPath).getSettings()).data!.ai.chat
  expect(getChatContextLimits(restored)).toEqual({ contextWindowTokens: 50000, maxOutputTokens: 2048 })
  expect(getChatContextWindowTokens({ ...restored, provider: 'custom' })).toBe(262144)
  expect(getChatContextWindowTokens({ ...restored, baseUrl: 'http://localhost:11435' })).toBe(262144)
  expect((await service.patchSettings({ ai: { chat: { model: 'other' } } })).success).toBe(true)
  expect(getChatContextWindowTokens((await service.getSettings()).data!.ai.chat)).toBe(262144)
  await service.patchSettings({ ai: { chat: { model: chat.model } } })
  await patch({ overrideTokens: null })
  expect(getChatContextWindowTokens((await service.getSettings()).data!.ai.chat)).toBe(32768)
  await patch({ discovered: null })
  expect(getChatContextLimits((await service.getSettings()).data!.ai.chat)).toEqual({ contextWindowTokens: 262144 })
})
