import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('bundled font styles', () => {
  it('gives italic emphasis an explicit angle without resetting nested bold synthesis', () => {
    const css = read('src/renderer/styles/fonts.css')
    expect(css).toMatch(/\.markdown-body\.markdown-body :is\(em, i\),\s*\.ai-markdown :is\(em, i\)\s*\{\s*font-style: oblique 16deg;\s*\}/s)
  })

  it('uses a real Medium descriptor and enables bold synthesis only on emphasis', () => {
    const css = read('src/renderer/styles/fonts.css')
    expect(css).toMatch(/src: url\('\.\.\/assets\/fonts\/wenkai-medium.ttf'\)[^}]*font-weight: 500;/s)
    expect(css).toMatch(/\.markdown-body\.markdown-body :is\(strong, b\),\s*\.ai-markdown :is\(strong, b\)\s*\{[^}]*font-weight: 700;[^}]*font-synthesis: weight style;/s)
  })

  it('ships local fonts for all three presets with redistributable licenses', () => {
    const path = 'src/renderer/styles/fonts.css'
    expect(existsSync(path)).toBe(true)
    const css = read(path)
    for (const name of ['LoomaSans', 'LoomaSerif', 'LoomaWenkai', 'LoomaMono']) expect(css).toContain(name)
    for (const preset of ['simple', 'literary', 'handwritten']) expect(css).toContain(`[data-font-preset="${preset}"]`)
    expect(css).not.toMatch(/https?:\/\//)
    for (const match of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
      expect(existsSync(resolve('src/renderer/styles', match[1]))).toBe(true)
    }
    for (const name of ['sans-LICENSE.txt', 'serif-LICENSE.txt', 'wenkai-OFL.txt', 'mono-OFL.txt']) {
      expect(read(`public/font-licenses/${name}`)).toContain('SIL OPEN FONT LICENSE')
    }
    expect(read('src/renderer/styles/style.css')).toContain('@import "./fonts.css"')
  })
})
