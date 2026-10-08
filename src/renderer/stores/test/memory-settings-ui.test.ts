import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('exposes one accessible maintenance switch with persistence and honest boundary copy', () => {
  const source = readFileSync('src/renderer/components/settings/MemorySettings.vue', 'utf8')
  expect(source).toContain('role="switch"')
  expect(source).toContain('aria-label="自动维护用户画像"')
  expect(source).toContain(':aria-checked="settingsStore.autoMaintainUserProfile"')
  expect(source).toContain('settingsStore.setAutoMaintainUserProfile(!settingsStore.autoMaintainUserProfile)')
  expect(source).toContain('settingsStore.memorySettingsBusy')
  expect(source).toContain('不会删除')
  expect(source).toContain('已经开始保存的操作不会撤销')
  expect(source).toContain('settingsStore.lastError')
})
it('moves static descriptions into adjacent help tooltips while keeping errors visible', () => {
  const source = readFileSync('src/renderer/components/settings/MemorySettings.vue', 'utf8')
  expect(source.match(/<SettingsHelp\b/g)).toHaveLength(4)
  expect(source).not.toMatch(/<p[^>]*>保存在本机/)
  expect(source).not.toMatch(/<p[^>]*>默认开启/)
  expect(source).not.toMatch(/<p[^>]*>\{\{ entry.description/)
  expect(source).toContain('role="alert"')
})
