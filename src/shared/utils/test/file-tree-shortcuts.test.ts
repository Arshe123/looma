import { describe, expect, it, vi } from 'vitest'
import { handleFileTreeGlobalKeyDown } from '../file-tree-shortcuts'
import { createDefaultAppShortcutSettings } from '../app-shortcuts'

const createHandlers = (platform: string, key: string) => {
  const preventDefault = vi.fn()
  const deleteEntries = vi.fn()
  return {
    preventDefault,
    deleteEntries,
    handled: handleFileTreeGlobalKeyDown({
      event: {
        key,
        target: null,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        preventDefault,
      },
      platform,
      shortcuts: createDefaultAppShortcutSettings(),
      selectedPaths: ['notes/example.md'],
      hasInlineEdit: false,
      activeElement: null,
      closeMenu: vi.fn(),
      startRename: vi.fn(),
      deleteEntries,
      copyEntries: vi.fn(),
      cutEntries: vi.fn(),
      pasteEntries: vi.fn(),
    }),
  }
}

describe('file tree delete shortcut', () => {
  it('uses Backspace to delete selected entries on macOS', () => {
    const result = createHandlers('darwin', 'Backspace')

    expect(result.handled).toBe(true)
    expect(result.preventDefault).toHaveBeenCalledOnce()
    expect(result.deleteEntries).toHaveBeenCalledWith(['notes/example.md'])
  })

  it('keeps Delete as the delete key on Windows', () => {
    const result = createHandlers('win32', 'Delete')

    expect(result.handled).toBe(true)
    expect(result.preventDefault).toHaveBeenCalledOnce()
    expect(result.deleteEntries).toHaveBeenCalledWith(['notes/example.md'])
  })

  it('does not treat Backspace as delete outside macOS', () => {
    const result = createHandlers('win32', 'Backspace')

    expect(result.handled).toBe(false)
    expect(result.preventDefault).not.toHaveBeenCalled()
    expect(result.deleteEntries).not.toHaveBeenCalled()
  })

  it('uses customized file operation shortcuts', () => {
    const preventDefault = vi.fn()
    const deleteEntries = vi.fn()
    const shortcuts = createDefaultAppShortcutSettings()
    shortcuts.deleteFiles = {
      key: 'D', ctrl: true, alt: true, shift: false, meta: false, enabled: true,
    }

    const handled = handleFileTreeGlobalKeyDown({
      event: {
        key: 'd', target: null, ctrlKey: true, altKey: true, shiftKey: false,
        metaKey: false, preventDefault,
      },
      platform: 'win32',
      shortcuts,
      selectedPaths: ['notes/example.md'],
      hasInlineEdit: false,
      activeElement: null,
      closeMenu: vi.fn(),
      startRename: vi.fn(),
      deleteEntries,
      copyEntries: vi.fn(),
      cutEntries: vi.fn(),
      pasteEntries: vi.fn(),
    })

    expect(handled).toBe(true)
    expect(deleteEntries).toHaveBeenCalledWith(['notes/example.md'])
  })
})