import { describe, expect, it } from 'vitest'
import {
  createDefaultEditorShortcutSettings,
  formatEditorShortcut,
  getAdjustedHeadingLevel,
  getTextFormatShortcutAction,
  matchesEditorShortcut,
  normalizeEditorShortcutSettings,
  shortcutFromKeyboardEvent,
} from '../editor-shortcuts'

const keyboardEvent = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: '1',
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...overrides,
}) as KeyboardEvent

describe('editor shortcut settings', () => {
  it('provides the standard rich-text format shortcuts', () => {
    const shortcuts = createDefaultEditorShortcutSettings()

    expect(formatEditorShortcut(shortcuts.bold)).toBe('Ctrl + B')
    expect(formatEditorShortcut(shortcuts.italic)).toBe('Ctrl + I')
    expect(formatEditorShortcut(shortcuts.strike)).toBe('Ctrl + Shift + S')
    expect(formatEditorShortcut(shortcuts.inlineCode)).toBe('Ctrl + E')
    expect(formatEditorShortcut(shortcuts.highlight)).toBe('Ctrl + L')
  })

  it('resolves configured format shortcuts on Windows and macOS', () => {
    const shortcuts = createDefaultEditorShortcutSettings()

    expect(getTextFormatShortcutAction(
      keyboardEvent({ key: 'b' }),
      shortcuts,
    )).toBe('bold')
    expect(getTextFormatShortcutAction(
      keyboardEvent({ key: 'i', ctrlKey: false, metaKey: true }),
      shortcuts,
      'darwin',
    )).toBe('italic')
  })

  it('blocks TipTap native bindings when a format shortcut is disabled or changed', () => {
    const disabled = createDefaultEditorShortcutSettings()
    disabled.bold.enabled = false
    expect(getTextFormatShortcutAction(keyboardEvent({ key: 'b' }), disabled)).toBe('blocked')

    const customized = createDefaultEditorShortcutSettings()
    customized.italic.key = 'K'
    expect(getTextFormatShortcutAction(keyboardEvent({ key: 'i' }), customized)).toBe('blocked')
    expect(getTextFormatShortcutAction(keyboardEvent({ key: 'k' }), customized)).toBe('italic')
  })

  it('uses Ctrl+L for toggling text highlight', () => {
    const shortcut = createDefaultEditorShortcutSettings().highlight

    expect(formatEditorShortcut(shortcut)).toBe('Ctrl + L')
    expect(matchesEditorShortcut(keyboardEvent({ key: 'l' }), shortcut)).toBe(true)
    expect(matchesEditorShortcut(
      keyboardEvent({ key: 'l', ctrlKey: false, metaKey: true }),
      shortcut,
      'darwin',
    )).toBe(true)
  })

  it('creates independent Ctrl+1 through Ctrl+9 menu bindings', () => {
    const first = createDefaultEditorShortcutSettings()
    const second = createDefaultEditorShortcutSettings()

    expect(first.inlineMenuSlots.map(formatEditorShortcut)).toEqual([
      'Ctrl + 1', 'Ctrl + 2', 'Ctrl + 3', 'Ctrl + 4', 'Ctrl + 5',
      'Ctrl + 6', 'Ctrl + 7', 'Ctrl + 8', 'Ctrl + 9',
    ])
    first.inlineMenuSlots[0].enabled = false
    expect(second.inlineMenuSlots[0].enabled).toBe(true)
  })

  it('normalizes partial persisted values while preserving disabled bindings', () => {
    const settings = normalizeEditorShortcutSettings({
      headingLevelUp: { key: 'k', ctrl: true, alt: true, enabled: false },
      inlineMenuSlots: [{ key: 'F1', ctrl: true, enabled: false }],
    })

    expect(settings.headingLevelUp).toEqual({
      key: 'K',
      ctrl: true,
      alt: true,
      shift: false,
      meta: false,
      enabled: false,
    })
    expect(settings.inlineMenuSlots[0].key).toBe('F1')
    expect(settings.inlineMenuSlots[0].enabled).toBe(false)
    expect(settings.inlineMenuSlots).toHaveLength(9)
    expect(formatEditorShortcut(settings.inlineMenuSlots[1])).toBe('Ctrl + 2')
  })

  it('falls back from persisted shortcuts that could intercept ordinary typing', () => {
    const settings = normalizeEditorShortcutSettings({
      headingLevelUp: {
        key: 'x',
        ctrl: false,
        alt: false,
        meta: false,
        shift: true,
        enabled: false,
      },
    })

    expect(settings.headingLevelUp).toMatchObject({
      key: '=',
      ctrl: true,
      shift: false,
      enabled: false,
    })
  })

  it('captures modified keys but rejects bare typing and modifier-only events', () => {
    expect(shortcutFromKeyboardEvent(keyboardEvent({ key: 'k', ctrlKey: false }))).toBeNull()
    expect(shortcutFromKeyboardEvent(keyboardEvent({ key: 'Control' }))).toBeNull()
    expect(shortcutFromKeyboardEvent(keyboardEvent({ key: 'k', altKey: true }))).toMatchObject({
      key: 'K',
      ctrl: true,
      alt: true,
    })
  })

  it('treats Shift as implicit for the plus symbol', () => {
    const event = keyboardEvent({ key: '+', shiftKey: true })
    const shortcut = shortcutFromKeyboardEvent(event)

    expect(shortcut).not.toBeNull()
    expect(matchesEditorShortcut(event, shortcut!)).toBe(true)
    expect(formatEditorShortcut(shortcut!)).toBe('Ctrl + +')
  })

  it('does not match disabled or differently modified shortcuts', () => {
    const shortcut = createDefaultEditorShortcutSettings().inlineMenuSlots[0]
    expect(matchesEditorShortcut(keyboardEvent(), shortcut)).toBe(true)
    expect(matchesEditorShortcut(keyboardEvent({ altKey: true }), shortcut)).toBe(false)
    expect(matchesEditorShortcut(keyboardEvent(), { ...shortcut, enabled: false })).toBe(false)
  })

  it('maps portable Ctrl bindings to Command on macOS', () => {
    const shortcut = createDefaultEditorShortcutSettings().inlineMenuSlots[0]
    const commandEvent = keyboardEvent({ ctrlKey: false, metaKey: true })

    expect(matchesEditorShortcut(commandEvent, shortcut, 'darwin')).toBe(true)
    expect(matchesEditorShortcut(keyboardEvent(), shortcut, 'darwin')).toBe(false)
    expect(formatEditorShortcut(shortcut, 'darwin')).toBe('⌘ + 1')
    expect(shortcutFromKeyboardEvent(commandEvent, 'darwin')).toMatchObject({
      ctrl: true,
      meta: false,
    })
  })
})

describe('heading level adjustment', () => {
  it('raises a paragraph through H6 toward H1', () => {
    expect(getAdjustedHeadingLevel(null, 'up')).toBe(6)
    expect(getAdjustedHeadingLevel(6, 'up')).toBe(5)
  })

  it('raises headings toward H1 and holds the H1 boundary', () => {
    expect(getAdjustedHeadingLevel(3, 'up')).toBe(2)
    expect(getAdjustedHeadingLevel(1, 'up')).toBe(1)
  })

  it('lowers headings through H6 and then converts to a paragraph', () => {
    expect(getAdjustedHeadingLevel(1, 'down')).toBe(2)
    expect(getAdjustedHeadingLevel(6, 'down')).toBe('paragraph')
  })
})
