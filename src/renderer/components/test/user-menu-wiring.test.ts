import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

describe('user menu overlay', () => {
  it('escapes sidebar clipping and anchors to the user button', () => {
    const menu = source('../user/UserMenu.vue')
    const sidebar = source('../Sidebar.vue')
    expect(menu).toContain('<Teleport to="body">')
    expect(menu).toMatch(/class="fixed /)
    expect(menu).toContain('getBoundingClientRect()')
    expect(sidebar).toContain(':anchor="userEntryRef"')
    expect(sidebar).toContain('ref="userEntryRef"')
    expect(menu).toContain('@pointerdown.stop')
  })
})
