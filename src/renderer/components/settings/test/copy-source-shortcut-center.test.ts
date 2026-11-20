import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transformSync } from 'esbuild'
import * as appShortcuts from '../../../../shared/utils/app-shortcuts'
import * as editorShortcuts from '../../../../shared/utils/editor-shortcuts'
import * as menuActions from '../../../../shared/utils/tiptap-menu-actions'
import * as zoom from '../../../../shared/utils/rich-text-zoom'

function shortcutCenter() {
  const store = {
    inlineMenuItems: [], appShortcuts: appShortcuts.createDefaultAppShortcutSettings(),
    editorShortcuts: editorShortcuts.createDefaultEditorShortcutSettings(),
    setAppShortcut: vi.fn(), setEditorShortcut: vi.fn(), resetEditorShortcuts: vi.fn(),
  }
  const descriptor = parse(readFileSync(new URL('../EditorSettings.vue', import.meta.url), 'utf8')).descriptor
  const code = transformSync(compileScript(descriptor, { id: 'shortcut-center-test' }).content, { loader: 'ts', format: 'cjs' }).code
  const module = { exports: {} as { default: { setup: (props: unknown, context: unknown) => any } } }
  const dependencies: Record<string, unknown> = {
    vue: { ...Vue, onMounted: () => {}, onBeforeUnmount: () => {} }, 'lucide-vue-next': {},
    '@/renderer/stores/settings': { useSettingsStore: () => store },
    '@/renderer/stores/workspace': { useWorkspaceStore: () => ({ requestConfirmation: async () => true }) },
    '@/shared/utils/app-shortcuts': appShortcuts, '@/shared/utils/editor-shortcuts': editorShortcuts,
    '@/shared/utils/tiptap-menu-actions': menuActions, '@/shared/utils/rich-text-zoom': zoom,
  }
  new Function('require', 'module', 'exports', 'window', code)((id: string) => {
    if (!(id in dependencies)) throw new Error(`Unexpected dependency: ${id}`)
    return dependencies[id]
  }, module, module.exports, { electronAPI: { platform: 'darwin' } })
  return { store, center: module.exports.default.setup({}, { expose: () => {} }) }
}

describe('source-copy shortcut center integration', () => {
  it('lists source copy as editable and fixed-enabled and includes it in conflicts/defaults', async () => {
    const { store, center } = shortcutCenter()
    const row = center.shortcutRows.value.find((row: { target: string }) => row.target === 'copySource')
    expect(row).toMatchObject({ command: '复制源码', editable: true, shortcut: '⌘ + Shift + C', category: 'file' })
    expect(center.isAppShortcutTarget('copySource')).toBe(true)
    expect(center.defaultShortcutRows.value.get('copySource')).toEqual(store.appShortcuts.copySource)
    expect(center.findShortcutConflict('bold', store.appShortcuts.copySource)).toBe(row)
    center.startRecording('bold')
    await center.handleShortcutRecording({ key: 'C', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, preventDefault() {}, stopImmediatePropagation() {} })
    expect(center.shortcutError.value).toContain('复制源码')
    expect(store.setEditorShortcut).not.toHaveBeenCalled()
    center.startRecording('copySource')
    await center.handleShortcutRecording({ key: 'K', metaKey: true, ctrlKey: false, altKey: true, shiftKey: true, preventDefault() {}, stopImmediatePropagation() {} })
    expect(store.setAppShortcut).toHaveBeenCalledWith('copySource', expect.objectContaining({ key: 'K', ctrl: true, alt: true, enabled: true }))
    await center.resetEditorShortcuts()
    expect(store.resetEditorShortcuts).toHaveBeenCalledOnce()
  })
})
