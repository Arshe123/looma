import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createAppSettingsService } from '../appSettingsService'

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
