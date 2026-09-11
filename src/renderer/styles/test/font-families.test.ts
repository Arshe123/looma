import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('bundled font styles', () => {
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
