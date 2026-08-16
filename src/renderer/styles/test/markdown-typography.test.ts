import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  fileURLToPath(new URL('../style.css', import.meta.url)),
  'utf8',
)

describe('markdown typography', () => {
  it('allows synthetic italic glyphs for fonts without an italic face', () => {
    expect(stylesheet).toMatch(/\.markdown-body\s*\{[^}]*font-synthesis:\s*style;/s)
  })
})
