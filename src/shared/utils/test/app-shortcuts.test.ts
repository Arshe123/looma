import { describe, expect, it } from 'vitest'
import {
  createDefaultAppShortcutSettings,
  getAppShortcutDefinitions,
  matchesAppShortcut,
  normalizeAppShortcutSettings,
} from '../app-shortcuts'

describe('fixed shortcut definitions', () => {
  it('lists every application and file shortcut on Windows', () => {
    const shortcuts = getAppShortcutDefinitions(createDefaultAppShortcutSettings(), 'win32')

    expect(shortcuts.map(item => item.id)).toEqual([
      'open-workspace',
      'new-workspace',
      'command-palette',
      'new-file',
      'save-file',
      'undo-file-operation',
      'redo-file-operation',
      'copy-files',
      'cut-files',
      'paste-files',
      'rename-file',
      'delete-files',
      'open-inline-menu',
    ])
    expect(shortcuts.find(item => item.id === 'command-palette')?.shortcut).toBe('Ctrl + Shift + P')
    expect(shortcuts.find(item => item.id === 'rename-file')?.shortcut).toBe('F2')
  })

  it('formats primary shortcuts for macOS', () => {
    const shortcuts = getAppShortcutDefinitions(createDefaultAppShortcutSettings(), 'darwin')

    expect(shortcuts.find(item => item.id === 'open-workspace')?.shortcut).toBe('⌘ + O')
    expect(shortcuts.find(item => item.id === 'new-workspace')?.shortcut).toBe('⌘ + Shift + N')
    expect(shortcuts.find(item => item.id === 'delete-files')?.shortcut).toBe('⌫')
    expect(shortcuts.find(item => item.id === 'open-inline-menu')?.shortcut).toBe('⌘ + Shift + Enter')
  })

  it('preserves customized bindings but forces fixed commands to stay enabled', () => {
    const shortcuts = normalizeAppShortcutSettings({
      openWorkspace: { key: 'K', ctrl: true, alt: true, enabled: false },
      renameFile: { key: 'F3', ctrl: false, alt: false, meta: false, enabled: false },
    })

    expect(shortcuts.openWorkspace).toMatchObject({ key: 'K', ctrl: true, alt: true, enabled: true })
    expect(shortcuts.renameFile).toMatchObject({ key: 'F3', ctrl: false, enabled: true })
  })

  it('matches a customized fixed shortcut', () => {
    const shortcut = normalizeAppShortcutSettings({
      saveFile: { key: 'K', ctrl: true, alt: true },
    }).saveFile

    expect(matchesAppShortcut({
      key: 'k', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false,
    }, shortcut, 'win32')).toBe(true)
  })
})