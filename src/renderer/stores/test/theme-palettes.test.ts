import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { THEME_PALETTES } from '../../theme'

const css = readFileSync('src/renderer/styles/style.css', 'utf8')
const tokens = (selector: string) => {
  const start = css.indexOf(`${selector} {`)
  expect(start, `Missing ${selector}`).toBeGreaterThanOrEqual(0)
  return Object.fromEntries([...css.slice(start, css.indexOf('}', start)).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]))
}

describe('built-in palette colors', () => {
  it.each(['light', 'dark'])('provides every default token for every %s palette', (mode) => {
    const defaults = tokens(`[data-theme="${mode}"]`)
    for (const palette of THEME_PALETTES.filter((item) => item.id !== 'paper')) {
      const colors = tokens(`[data-palette="${palette.id}"][data-theme="${mode}"]`)
      expect(Object.keys(colors).sort()).toEqual(Object.keys(defaults).sort())
      expect(colors['--surface']).not.toBe(defaults['--surface'])
      expect(colors['--accent']).not.toBe(defaults['--accent'])
    }
  })
  it('retains the original warm paper and dusk colors', () => {
    expect(tokens('[data-theme="light"]')).toMatchObject({ '--bg': '#efede6', '--surface': '#fcfbf7', '--accent': '#57705a', '--editor-active-line-bg': 'rgb(87 112 90 / 0.06)' })
    expect(tokens('[data-theme="dark"]')).toMatchObject({ '--bg': '#202522', '--surface': '#2e352f', '--accent': '#b3c5a0', '--editor-active-line-bg': 'rgb(255 255 255 / 0.04)' })
  })
})
