import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { transformSync } from 'esbuild'
import { createDefaultAppShortcutSettings, matchesAppShortcut, normalizeAppShortcutSettings } from '../../../../shared/utils/app-shortcuts'
import { isPrimaryModifierPressed } from '../../../../shared/utils/platform-shortcuts'
import { createDefaultEditorShortcutSettings, getTextFormatShortcutAction, matchesEditorShortcut } from '../../../../shared/utils/editor-shortcuts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const ordinary = read('../TiptapPreview.vue')
const continuous = read('../../editor/ChunkedMarkdownEditor.vue')

// Exercise the actual component handlers without mounting either editor/DOM.
function handler(kind: 'ordinary' | 'continuous', platform: string, appShortcuts = createDefaultAppShortcutSettings(), sourceOnly = false) {
  const copySource = vi.fn().mockResolvedValue(true)
  const copyPlain = vi.fn().mockResolvedValue(true)
  const context = {
    window: { electronAPI: { platform } }, settingsStore: { appShortcuts }, settings: { appShortcuts, editorShortcuts: createDefaultEditorShortcutSettings() },
    matchesAppShortcut, isPrimaryModifierPressed, copyRichTextSource: copySource, copyRichTextSelection: copyPlain,
    clipboard: { copySource }, enabled: true, props: { sourceOnly }, view: { composing: false }, editor: { value: null },
    matchesEditorShortcut, getTextFormatShortcutAction,
  }
  const source = kind === 'ordinary'
    ? ordinary.match(/handleKeyDown: (\(_view, event\) => \{[\s\S]*?)\n {6}\},\n {6}handleDOMEvents:/)![1] + '\n}'
    : continuous.match(/function handleKeyDown\(event: KeyboardEvent\) \{[\s\S]*?\n\}/)![0]
  const code = transformSync(`const run = ${source};`, { loader: 'ts' }).code
  const run = new Function(...Object.keys(context), `${code}; return run`)(...Object.values(context))
  return { copySource, copyPlain, run: (event: unknown) => kind === 'ordinary' ? run(null, event) : run(event) }
}
const key = (platform: string, value = 'C', shiftKey = true) => ({
  key: value, ctrlKey: platform !== 'darwin', metaKey: platform === 'darwin', shiftKey, altKey: false,
  preventDefault: vi.fn(),
})

describe('copy source shortcut', () => {
  it('documents the shortcut and shared shortcut-center configuration entry', () => {
    const help = read('../../help/help.md')
    expect(help.includes('| `Ctrl + Shift + C` | 复制源码')).toBe(true)
    expect(help).toContain('固定启用、可改键')
  })
  for (const kind of ['ordinary', 'continuous'] as const) {
    for (const platform of ['darwin', 'win32']) {
      it(`${kind} routes ${platform} default binding only through existing source copy`, () => {
        const host = handler(kind, platform)
        const event = key(platform)
        expect(host.run(event)).toBe(true)
        expect(event.preventDefault).toHaveBeenCalledOnce()
        expect(host.copySource).toHaveBeenCalledOnce()
        expect(host.copySource).toHaveBeenCalledWith()
        expect(host.copyPlain).not.toHaveBeenCalled()
      })
      it(`${kind} honors reassignment on ${platform}`, () => {
        const app = normalizeAppShortcutSettings({ copySource: { key: 'K', ctrl: true, shift: true, enabled: false } })
        const host = handler(kind, platform, app)
        const old = key(platform)
        expect(host.run(old)).toBe(false)
        expect(old.preventDefault).not.toHaveBeenCalled()
        expect(host.run(key(platform, 'K'))).toBe(true)
        expect(host.copySource).toHaveBeenCalledOnce()
      })
    }
  }
  it('keeps ordinary Ctrl/Cmd+C on the plain-copy path', () => {
    const host = handler('ordinary', 'darwin')
    expect(host.run(key('darwin', 'c', false))).toBe(true)
    expect(host.copyPlain).toHaveBeenCalledOnce()
    expect(host.copySource).not.toHaveBeenCalled()
  })
  it('does not intercept the continuous source-only editor', () => {
    const host = handler('continuous', 'darwin', createDefaultAppShortcutSettings(), true)
    expect(host.run(key('darwin'))).toBe(false)
    expect(host.copySource).not.toHaveBeenCalled()
  })
})
