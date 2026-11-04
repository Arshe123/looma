import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePreloadOutput } from '../preload-output.mjs'

describe('preload build output resolution', () => {
  it('prefers the nested preload output over a stale main-process index', () => {
    const outDir = path.resolve('repo', 'dist-electron')
    const nestedOutput = path.join(outDir, 'preload', 'index.js')
    const existing = new Set([
      path.join(outDir, 'index.js'),
      nestedOutput,
    ])

    expect(resolvePreloadOutput(outDir, candidate => existing.has(candidate))).toBe(
      nestedOutput,
    )
  })
})
