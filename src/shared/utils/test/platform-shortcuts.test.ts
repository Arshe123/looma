import { describe, expect, it } from 'vitest'
import {
  formatPrimaryShortcut,
  isPrimaryModifierPressed,
} from '../platform-shortcuts'

const modifierEvent = (ctrlKey: boolean, metaKey: boolean) => ({ ctrlKey, metaKey })

describe('platform shortcuts', () => {
  it('uses Command exclusively as the primary modifier on macOS', () => {
    expect(isPrimaryModifierPressed(modifierEvent(false, true), 'darwin')).toBe(true)
    expect(isPrimaryModifierPressed(modifierEvent(true, false), 'darwin')).toBe(false)
    expect(formatPrimaryShortcut('Shift+P', 'darwin')).toBe('⌘⇧P')
  })

  it('keeps Ctrl exclusively as the primary modifier on Windows', () => {
    expect(isPrimaryModifierPressed(modifierEvent(true, false), 'win32')).toBe(true)
    expect(isPrimaryModifierPressed(modifierEvent(false, true), 'win32')).toBe(false)
    expect(formatPrimaryShortcut('Shift+P', 'win32')).toBe('Ctrl+Shift+P')
  })
})
