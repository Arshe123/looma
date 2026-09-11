import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(`src/renderer/${path}`, 'utf8')

describe('font preset rendering integration', () => {
  it('connects application settings and the fixed-preset picker', () => {
    expect(read('App.vue')).toContain('watchFontPreset(() => settingsStore.fontPreset)')
    expect(read('components/settings/AppearanceSettings.vue')).toContain('<FontSettings />')
  })

  it('replaces hard-coded component families without changing editor sizing', () => {
    const editor = read('components/editor/Editor.vue')
    expect(editor).not.toContain("fontFamily: 'Consolas, Monaco, monospace'")
    expect(editor).toContain("fontFamily: 'var(--font-code)'")
    expect(editor).toContain("fontVariantLigatures: 'none'")
    for (const file of ['preview/TiptapPreview.vue', 'preview/NoteLinkPreview.vue', 'preview/CodeBlockView.vue', 'preview/LocalImageView.vue', 'help/HelpPage.vue', 'ai/AiMarkdown.vue']) {
      const source = read(`components/${file}`)
      expect(source).not.toMatch(/font-family:\s*(?:-apple-system|ui-monospace)/)
      expect(source).toContain('font-family: var(--font-code)')
    }
    expect(read('components/ai/AiMarkdown.vue')).toContain('font-family: var(--font-body)')
  })
})
