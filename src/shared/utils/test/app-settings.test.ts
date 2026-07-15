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

describe('normalizeAppSettings agent settings', () => {
  it('defaults to RAG mode with eight steps and all read-only tools enabled', () => {
    const settings = normalizeAppSettings({})

    expect(settings.ai.agent).toEqual({
      defaultMode: 'rag',
      maxSteps: 8,
      enabledTools: [
        'rag_search',
        'workspace_list',
        'workspace_search',
        'file_read',
      ],
    })
  })

  it('preserves valid agent settings through normalization', () => {
    const settings = normalizeAppSettings({
      ai: {
        agent: {
          defaultMode: 'agent',
          maxSteps: 24,
          enabledTools: ['workspace_search', 'file_read'],
        },
      },
    })

    expect(settings.ai.agent).toEqual({
      defaultMode: 'agent',
      maxSteps: 24,
      enabledTools: ['workspace_search', 'file_read'],
    })
  })

  it('normalizes invalid agent values and de-duplicates tools', () => {
    const settings = normalizeAppSettings({
      ai: {
        agent: {
          defaultMode: 'chat',
          maxSteps: 99,
          enabledTools: [
            'rag_search',
            'terminal',
            'rag_search',
            'workspace_list',
            'web',
          ],
        },
      },
    })

    expect(settings.ai.agent).toEqual({
      defaultMode: 'rag',
      maxSteps: 50,
      enabledTools: ['rag_search', 'workspace_list'],
    })
  })
})
