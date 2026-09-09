import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8')
const component = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('暮纸主题与布局接线', () => {
  it('uses the approved day/night palette and a shared light fallback', () => {
    expect(css).toContain(':root:not([data-theme]),\n[data-theme="light"]')
    for (const color of ['#efede6', '#f5f3ed', '#fcfbf7', '#363d35', '#57705a', '#202522', '#282e29', '#2e352f', '#e0e5db', '#b3c5a0']) {
      expect(css).toContain(color)
    }
    expect(css).toContain('.bg-accent.text-white')
    expect(css).toContain('color: var(--accent-contrast)')
  })

  it('places theme selection in the footer and AI/outline after the document', () => {
    const app = component('App.vue')
    const sidebar = component('components/Sidebar.vue')
    expect(app.indexOf('<MainContent />')).toBeLessThan(app.indexOf('<AiAssistant v-if='))
    expect(app).toMatch(/<footer[^>]*>\s*<ThemeSwitcher \/>/)
    expect(sidebar).not.toContain('workspaceStore.toggleTheme')
    expect(sidebar).not.toContain('<AiAssistant')
    expect(sidebar).not.toContain('<OutlinePanel')
  })

  it('keeps both rich-text paths on the document surface', () => {
    for (const name of ['TiptapPreview', 'ChunkedMarkdownPreview']) {
      expect(component(`components/preview/${name}.vue`)).toContain('bg-surface')
    }
  })
})
