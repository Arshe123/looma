import { describe, expect, it } from 'vitest'
import { normalizeAppSettings } from '../app-settings'

describe('built-in font preset settings', () => {
  it('defaults old settings to the selected handwritten pairing', () => {
    expect(normalizeAppSettings({})).toHaveProperty('appearance.fontPreset', 'handwritten')
  })

  it.each(['simple', 'literary', 'handwritten'])('preserves the %s preset without changing editor settings', (fontPreset) => {
    const settings = normalizeAppSettings({ appearance: { fontPreset }, editor: { richTextZoom: 125, showLineNumbers: false } })
    expect(settings).toHaveProperty('appearance.fontPreset', fontPreset)
    expect(settings.editor.showLineNumbers).toBe(false)
    expect(settings.editor.richTextZoom).toBe(125)
  })

  it.each([null, '', 'custom', '__proto__', 1, {}])('rejects unsupported presets: %s', (fontPreset) => {
    expect(normalizeAppSettings({ appearance: { fontPreset } })).toHaveProperty('appearance.fontPreset', 'handwritten')
  })
})
