import { describe, expect, it } from 'vitest'

describe('vite dev server file watching', () => {
  it('ignores user-editable note files so saving them does not reload the renderer', async () => {
    const fs = process.getBuiltinModule('fs/promises')
    const viteConfig = await fs.readFile(new URL('../../../../vite.config.ts', import.meta.url), 'utf-8')

    expect(viteConfig).toContain('server:')
    expect(viteConfig).toContain('watch:')
    expect(viteConfig).toContain('ignored:')
    expect(viteConfig).toContain("'**/*.md'")
    expect(viteConfig).toContain("'**/*.txt'")
  })
})
