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

describe('normalizeAppSettings inline menu customization', () => {
  it('includes highlight in the default inline menu', () => {
    expect(defaultAppSettings.inlineMenu.items).toContain('highlight')
  })

  it('adds highlight to the previous untouched default menu', () => {
    const settings = normalizeAppSettings({
      inlineMenu: {
        items: [
          'h2', 'h3', 'h4', 'h5', 'h6', 'bulletList', 'orderedList',
          'taskList', 'blockquote', 'codeBlock', 'image', 'table', 'horizontalRule',
        ],
      },
    })

    expect(settings.inlineMenu.items.at(-1)).toBe('highlight')
    expect(settings.inlineMenu.version).toBe(2)
  })

  it('does not re-add highlight after it is removed from the current menu version', () => {
    const settings = normalizeAppSettings({
      inlineMenu: {
        version: 2,
        items: [
          'h2', 'h3', 'h4', 'h5', 'h6', 'bulletList', 'orderedList',
          'taskList', 'blockquote', 'codeBlock', 'image', 'table', 'horizontalRule',
        ],
      },
    })

    expect(settings.inlineMenu.items).not.toContain('highlight')
  })

  it('preserves a customized menu without the image action', () => {
    const settings = normalizeAppSettings({
      inlineMenu: {
        items: ['h2', 'table', 'horizontalRule'],
      },
    })

    expect(settings.inlineMenu.items).toEqual(['h2', 'table', 'horizontalRule'])
  })

  it('respects a hidden image action from legacy object settings', () => {
    const settings = normalizeAppSettings({
      inlineMenu: {
        items: [
          { id: 'h2', visible: true },
          { id: 'image', visible: false },
          { id: 'table', visible: true },
        ],
      },
    })

    expect(settings.inlineMenu.items).toEqual(['h2', 'table'])
  })
})

describe('normalizeAppSettings editor shortcuts', () => {
  it('adds default editor shortcuts to existing settings', () => {
    const settings = normalizeAppSettings({ inlineMenu: { items: ['h2'] } })

    expect(settings.editor.shortcuts.headingLevelUp).toMatchObject({
      key: '=',
      ctrl: true,
      enabled: true,
    })
    expect(settings.editor.shortcuts.bold).toMatchObject({ key: 'B', ctrl: true, enabled: true })
    expect(settings.editor.shortcuts.italic).toMatchObject({ key: 'I', ctrl: true, enabled: true })
    expect(settings.editor.shortcuts.strike).toMatchObject({ key: 'S', ctrl: true, shift: true, enabled: true })
    expect(settings.editor.shortcuts.inlineCode).toMatchObject({ key: 'E', ctrl: true, enabled: true })
    expect(settings.editor.shortcuts.highlight).toMatchObject({
      key: 'L',
      ctrl: true,
      enabled: true,
    })
    expect(settings.editor.shortcuts.inlineMenuSlots).toHaveLength(9)
  })

  it('preserves customized and disabled shortcut bindings', () => {
    const settings = normalizeAppSettings({
      editor: {
        shortcuts: {
          headingLevelDown: {
            key: 'j',
            ctrl: true,
            alt: true,
            enabled: false,
          },
          inlineMenuSlots: [
            { key: 'F1', ctrl: true, enabled: false },
          ],
        },
      },
    })

    expect(settings.editor.shortcuts.headingLevelDown).toMatchObject({
      key: 'J',
      ctrl: true,
      alt: true,
      enabled: false,
    })
    expect(settings.editor.shortcuts.inlineMenuSlots[0]).toMatchObject({
      key: 'F1',
      enabled: false,
    })
  })

  it('adds and preserves customizable always-enabled application shortcuts', () => {
    const settings = normalizeAppSettings({
      editor: {
        appShortcuts: {
          newFile: { key: 'K', ctrl: true, alt: true, enabled: false },
        },
      },
    })

    expect(settings.editor.appShortcuts.openWorkspace).toMatchObject({ key: 'O', enabled: true })
    expect(settings.editor.appShortcuts.newFile).toMatchObject({
      key: 'K',
      ctrl: true,
      alt: true,
      enabled: true,
    })
  })
})
