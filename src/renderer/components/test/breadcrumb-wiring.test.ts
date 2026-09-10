import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

describe('footer breadcrumb wiring', () => {
  it('places navigation on the left of the existing theme switcher', () => {
    const app = source('../../App.vue')
    expect(app).toContain('import BreadcrumbNavigation')
    expect(app).toMatch(/<footer[^>]*>[\s\S]*<BreadcrumbNavigation\s*\/>[\s\S]*<ThemeSwitcher\s*\/>[\s\S]*<\/footer>/)
  })

  it('keeps the upward menu entry-only and reads directories without changing file-tree selection', () => {
    const component = source('../BreadcrumbNavigation.vue')
    expect(component).toContain('window.electronAPI.fs.listDir')
    expect(component).toContain('workspaceStore.openFileTab')
    expect(component).not.toMatch(/workspaceStore\.(selectDir|selectPath|toggleDirExpanded|loadDir)\(/)
    expect(component).toContain('EDITOR_FOCUS_EVENT')
    expect(component).toContain('aria-label="目录选择"')
    expect(component).not.toMatch(/选择文件夹以继续|选择文件以打开|menu-head|menu-foot/)
  })
})
