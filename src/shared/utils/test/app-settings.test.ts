import { describe, expect, it } from 'vitest'
import { defaultAppSettings, normalizeAppSettings } from '../app-settings'

describe('normalizeAppSettings RAG chunking strategy', () => {
  it('defaults chunkingStrategy to fixed', () => {
    const settings = normalizeAppSettings({})

    expect(settings.ai.chunkingStrategy).toBe('fixed')
  })

  it('preserves markdown chunking strategy from settings JSON', () => {
    const settings = normalizeAppSettings({
      ai: {
        chunkingStrategy: 'markdown',
        chunkSize: 512,
        chunkOverlap: 64,
      },
    })

    expect(settings.ai.chunkingStrategy).toBe('markdown')
    expect(settings.ai.chunkSize).toBe(512)
    expect(settings.ai.chunkOverlap).toBe(64)
  })

  it('falls back to default for unsupported chunking strategy', () => {
    const settings = normalizeAppSettings({
      ai: {
        chunkingStrategy: 'unknown-strategy',
      },
    })

    expect(settings.ai.chunkingStrategy).toBe(defaultAppSettings.ai.chunkingStrategy)
  })
})
