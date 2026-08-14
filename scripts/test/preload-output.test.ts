import { describe, expect, it } from 'vitest'
import { resolvePreloadOutput } from '../preload-output.mjs'

describe('preload build output resolution', () => {
  it('prefers the nested preload output over a stale main-process index', () => {
    const existing = new Set([
      '/repo/dist-electron/index.js',
      '/repo/dist-electron/preload/index.js',
    ])

    expect(resolvePreloadOutput('/repo/dist-electron', path => existing.has(path))).toBe(
      '/repo/dist-electron/preload/index.js',
    )
  })
})
