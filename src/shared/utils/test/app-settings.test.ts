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

  it('normalizes conversation context strategy and legacy snake_case keys', () => {
    const settings = normalizeAppSettings({
      ai: {
        conversation_context: {
          context_strategy: 'sliding_window',
          recent_turns: '8',
          summary_max_messages: '32',
          summary_max_chars: '1600',
        },
      },
    })

    expect(settings.ai.conversationContext).toEqual({
      strategy: 'sliding_window',
      recentTurns: 8,
      summaryMaxMessages: 32,
      summaryMaxChars: 1600,
    })
  })

  it('maps legacy disabled distant summary to sliding window strategy', () => {
    const settings = normalizeAppSettings({
      ai: {
        conversation_context: {
          enable_distant_summary: false,
        },
      },
    })

    expect(settings.ai.conversationContext.strategy).toBe('sliding_window')
  })
})

describe('normalizeAppSettings Agent-only migration', () => {
  it('does not expose Agent tool settings to users', () => {
    const settings = normalizeAppSettings({})
    expect(settings.ai).not.toHaveProperty('agent')
  })

  it('drops legacy Agent tool and step overrides', () => {
    const settings = normalizeAppSettings({
      ai: {
        agent: {
          maxSteps: 24,
          enabledTools: ['file_read'],
        },
      },
    })
    expect(settings.ai).not.toHaveProperty('agent')
  })
})
