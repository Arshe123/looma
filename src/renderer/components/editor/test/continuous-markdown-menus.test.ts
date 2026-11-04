import { describe, expect, it } from 'vitest'
import { createDefaultAppShortcutSettings } from '../../../../shared/utils/app-shortcuts'
import { createDefaultEditorShortcutSettings } from '../../../../shared/utils/editor-shortcuts'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { getTableMenuActions } from '../../../../shared/utils/tiptap-menu-actions'
import { parsedMarkdownState } from './parsed-markdown-state'
import { getContinuousMenuContext, continuousMenuPosition, getContinuousContextSelection, continuousTableMenuItems, continuousMarkdownMenus, refreshContinuousMarkdownMenus, resolveContinuousMenuShortcut } from '../continuousMarkdownMenus'

const state = (doc: string, anchor = doc.length, head = anchor, readOnly = false) => parsedMarkdownState(EditorState.create({
  doc, selection: { anchor, head }, extensions: [markdown({ base: markdownLanguage }), EditorState.readOnly.of(readOnly)],
}))

describe('continuous menu context policy', () => {
  it('offers + only for a collapsed editable blank outside literal code', () => {
    expect(getContinuousMenuContext(state('a\n\n'), 3).blank).toBe(true)
    expect(getContinuousMenuContext(state('a\n  '), 4).blank).toBe(true)
    expect(getContinuousMenuContext(state('a'), 1).blank).toBe(false)
    expect(getContinuousMenuContext(state('a\n\n', 0, 3), 3).blank).toBe(false)
    expect(getContinuousMenuContext(state('\n', 0, 0, true), 0).blank).toBe(false)
    const fenced = '```js\n\n```'
    expect(getContinuousMenuContext(state(fenced, 6), 6).blank).toBe(false)
    const indented = '    a\n    \n    b'
    expect(getContinuousMenuContext(state(indented, 8), 8).blank).toBe(false)
  })
  it('offers source copy for the continuous editor highlight syntax', () => {
    expect(getContinuousMenuContext(state('==高亮==', 0, 6)).copySource).toBe(true)
    expect(getContinuousMenuContext(state('普通文本', 0, 4)).copySource).toBe(false)
  })
  it('keeps hot-path source reads bounded and does not flatten a giant line', () => {
    const source = 'x'.repeat(200000)
    const editor = state(source, 100000)
    const originalSlice = editor.doc.sliceString.bind(editor.doc)
    Object.defineProperty(editor.doc, 'toString', { value: () => { throw new Error('must not flatten source') } })
    Object.defineProperty(editor.doc, 'sliceString', { value: (from: number, to: number) => {
      expect(to - from).toBeLessThanOrEqual(4096)
      return originalSlice(from, to)
    } })
    expect(getContinuousMenuContext(editor).blank).toBe(false)
    expect(getContinuousMenuContext(editor).target).toBe(null)
  })
  it('finds source ranges for clicked links/images but never treats inline code as a link', () => {
    const doc = 'before [**说明**](note.md#L2 "标题") ![图](assets/a.png) after'
    const link = getContinuousMenuContext(state(doc), doc.indexOf('说明')).target
    expect(link?.kind).toBe('link')
    expect(doc.slice(link!.from, link!.to)).toBe('[**说明**](note.md#L2 "标题")')
    expect(link?.destination).toEqual({ from: doc.indexOf('note.md'), to: doc.indexOf('note.md') + 'note.md#L2'.length })
    const image = getContinuousMenuContext(state(doc), doc.indexOf('图')).target
    expect(image?.kind).toBe('image')
    expect(doc.slice(image!.from, image!.to)).toBe('![图](assets/a.png)')
    expect(getContinuousMenuContext(state('`[x](y)`'), 3).target).toBe(null)
  })
  it('recognizes table selection and formatted-source selections without copying text', () => {
    const doc = '| A | B |\n| --- | --- |\n| C | D |'
    expect(getContinuousMenuContext(state(doc, 2), 2).table).toBe(true)
    expect(getContinuousMenuContext(state('plain', 0, 5), 0).copySource).toBe(false)
    expect(getContinuousMenuContext(state('**bold**', 0, 8), 0).copySource).toBe(true)
    expect(getContinuousMenuContext(state('**bold**', 3), 3).copySource).toBe(false)
  })
  it('keeps image width attributes in the context-menu source range', () => {
    const source = '![图](assets/a.png "标题"){width=60%}'
    const target = getContinuousMenuContext(state(source, 2), 2).target!
    expect(source.slice(target.from, target.to)).toBe(source)
    expect(getContinuousContextSelection(state(source, 0), 2)).toEqual({ anchor: 0, head: source.length })
  })
})

describe('menu extension contract', () => {
  it('preserves every nonempty selection even when right clicking outside it', () => {
    const selected = state('before [x](note.md) after', 5, 1)
    expect(getContinuousContextSelection(selected, 10)).toEqual({ anchor: 5, head: 1 })
    expect(getContinuousContextSelection(state('[x](note.md)', 0), 2)).toEqual({ anchor: 0, head: 12 })
    expect(getContinuousContextSelection(state('plain', 0), 3)).toEqual({ anchor: 3, head: 3 })
  })
  it('uses exactly the ordinary table context-menu actions without extra alignment or delete-table entries', () => {
    expect(continuousTableMenuItems()).toEqual(getTableMenuActions().map(({ id, label }) => ({ id, label })))
    expect(continuousTableMenuItems().every(item => item.label && !('run' in item))).toBe(true)
  })
  it('can be installed and refreshed without a DOM, clipboard, source edit or history', () => {
    const configured = EditorState.create({ doc: 'unchanged', extensions: [continuousMarkdownMenus({
      inlineItems: () => ['table', 'image'], shortcuts: createDefaultEditorShortcutSettings,
      appShortcuts: createDefaultAppShortcutSettings, platform: 'darwin',
      runAction: () => { throw new Error('must not run during configuration') },
      insertTable: () => { throw new Error('must not run during configuration') },
    })] })
    const update = configured.update({ effects: refreshContinuousMarkdownMenus.of(null) })
    expect(update.docChanged).toBe(false)
    expect(update.state.doc).toBe(configured.doc)
    expect(update.state.selection).toBe(configured.selection)
  })
})

describe('fixed overlay geometry', () => {
  it('centers on the measured gutter box, not the number glyph', () => {
    expect(continuousMenuPosition({ left: 100, top: 30, width: 40, height: 28 }, 24)).toEqual({ left: 108, top: 32 })
  })
})

const key = (key: string, extra = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...extra })

describe('continuous markdown menu shortcuts', () => {
  it('maps configured slots without filtering unknown items and honors disabled slots', () => {
    const shortcuts = createDefaultEditorShortcutSettings()
    const app = createDefaultAppShortcutSettings()
    const items = ['unknown', 'table', 'image']
    expect(resolveContinuousMenuShortcut(key('2', { ctrlKey: true }), items, shortcuts, app, 'win32')).toBe('table')
    expect(resolveContinuousMenuShortcut(key('3', { metaKey: true }), items, shortcuts, app, 'darwin')).toBe('image')
    shortcuts.inlineMenuSlots[1].enabled = false
    expect(resolveContinuousMenuShortcut(key('2', { ctrlKey: true }), items, shortcuts, app, 'win32')).toBe(null)
    expect(resolveContinuousMenuShortcut(key('1', { ctrlKey: true }), items, shortcuts, app, 'win32')).toBe(null)
  })
  it('honors reassigned app and slot bindings on both platforms and ignores slots after nine', () => {
    const shortcuts = createDefaultEditorShortcutSettings()
    const app = createDefaultAppShortcutSettings()
    app.openInlineMenu = { ...app.openInlineMenu, key: 'Q', shift: false, alt: true }
    shortcuts.inlineMenuSlots[0] = { ...shortcuts.inlineMenuSlots[0], key: 'K', shift: true }
    for (const [platform, modifier] of [['darwin', 'metaKey'], ['win32', 'ctrlKey']]) {
      expect(resolveContinuousMenuShortcut(key('q', { [modifier]: true, altKey: true }), [], shortcuts, app, platform)).toBe('openInlineMenu')
      expect(resolveContinuousMenuShortcut(key('K', { [modifier]: true, shiftKey: true }), ['image'], shortcuts, app, platform)).toBe('image')
      expect(resolveContinuousMenuShortcut(key('1', { [modifier]: true }), ['image'], shortcuts, app, platform)).toBe(null)
    }
    shortcuts.inlineMenuSlots.push({ ...shortcuts.inlineMenuSlots[0], key: '0' })
    expect(resolveContinuousMenuShortcut(key('0', { ctrlKey: true, shiftKey: true }), Array(10).fill('image'), shortcuts, app, 'win32')).toBe(null)
  })
  it('uses the app shortcut and does not consume text, formatting, or empty slots', () => {
    const shortcuts = createDefaultEditorShortcutSettings()
    const app = createDefaultAppShortcutSettings()
    expect(resolveContinuousMenuShortcut(key('Enter', { metaKey: true, shiftKey: true }), [], shortcuts, app, 'darwin')).toBe('openInlineMenu')
    for (const event of [key('1'), key('b', { ctrlKey: true }), key('9', { ctrlKey: true })]) {
      expect(resolveContinuousMenuShortcut(event, ['paragraph'], shortcuts, app, 'win32')).toBe(null)
    }
    shortcuts.inlineMenuSlots[0] = { ...shortcuts.inlineMenuSlots[0], ctrl: false }
    expect(resolveContinuousMenuShortcut(key('1'), ['paragraph'], shortcuts, app, 'win32')).toBe(null)
  })
})
