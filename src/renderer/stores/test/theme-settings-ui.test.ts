import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(`src/renderer/components/${path}`, 'utf8')
describe('theme settings entry points', () => {
  it('connects the settings page to the real appearance controls', () => {
    expect(read('SettingsPage.vue')).toContain('<AppearanceSettings v-if="isAppearanceSection" />')
    const controls = read('settings/AppearanceSettings.vue')
    expect(controls).toContain('workspaceStore.setThemePalette(palette.id)')
    expect(controls).toContain('workspaceStore.restoreDefaultTheme()')
    expect(controls).toContain('<ThemeSwitcher />')
    expect(controls).toContain(':aria-pressed="workspaceStore.themePalette === palette.id"')
  })
})
