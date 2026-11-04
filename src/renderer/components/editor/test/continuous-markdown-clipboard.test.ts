import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { createContinuousMarkdownClipboard, type ContinuousMarkdownClipboardOptions } from '../continuousMarkdownClipboard'
import { history, undo, redo } from '@codemirror/commands'
import { parsedMarkdownState } from './parsed-markdown-state'

function fixture(source: string, overrides: Partial<ContinuousMarkdownClipboardOptions> = {}, readOnly = false) {
  let state = parsedMarkdownState(EditorState.create({ doc: source, selection: EditorSelection.range(0, source.length), extensions: [markdown(), history(), EditorState.readOnly.of(readOnly)] }))
  const writes: string[] = []
  const controller = createContinuousMarkdownClipboard({
    getView: () => view,
    readSource: (from, to) => state.doc.sliceString(from, to),
    writeText: async text => { writes.push(text) },
    ...overrides,
  })
  const view = { get state() { return state }, dispatch(spec: Parameters<EditorState['update']>[0]) { state = parsedMarkdownState(state.update(spec).state) }, focus() {} }
  return { controller, view, writes, get state() { return state } }
}

describe('continuous clipboard', () => {
  it('includes structural heading context when copying only heading text as source', async () => {
    const test = fixture('## 标题其余')
    test.view.dispatch({ selection: { anchor: 3, head: 5 } })
    await test.controller.copySource()
    expect(test.writes).toEqual(['## 标题'])
  })
  it('serializes a selected code fragment with its original block language', async () => {
    const source = '```js\nconst value = 1\n```'
    const test = fixture(source)
    const from = source.indexOf('value')
    test.view.dispatch({ selection: { anchor: from, head: from + 'value'.length } })
    await test.controller.copySource()
    expect(test.writes).toEqual(['```js\nvalue\n```'])
  })
  it('copies the complete source range without viewport truncation or normalization', async () => {
    const source = '# 标题\n\n' + '长段落 **原样**\n\n'.repeat(24000) + '![图](assets/a.png){width=60%}'
    const test = fixture(source)
    expect(await test.controller.copySource()).toBe(true)
    expect(test.writes).toEqual([source])
    expect(test.state.doc.toString()).toBe(source)
  })
  it('matches ordinary source-backed plain copy and copies an image as Markdown only', async () => {
    const test = fixture('# 标题\n\n**粗体** [链接](note.md)\n\n- 第一项\n- 第二项')
    expect(await test.controller.copy()).toBe(true)
    expect(test.writes).toEqual(['标题\n**粗体** [链接](note.md)\n第一项\n第二项'])
    const image = '![说明](assets/a.png "title"){width=60%}'
    const selectedImage = fixture(image)
    await selectedImage.controller.copy()
    expect(selectedImage.writes).toEqual([image])
  })
  it('pastes literal text in one transaction and refuses stale asynchronous reads', async () => {
    const test = fixture('原文')
    expect(test.controller.pastePayload({ text: '<b>不是HTML</b>' })).toBe(true)
    expect(test.state.doc.toString()).toBe('<b>不是HTML</b>')
    let resolve!: (payload: { text: string }) => void
    const reading = new Promise<{ text: string }>(done => { resolve = done })
    const pending = test.controller.paste(() => reading)
    test.controller.pastePayload({ text: '新内容' })
    resolve({ text: '迟到内容' })
    expect(await pending).toBe(false)
    expect(test.state.doc.toString()).not.toContain('迟到内容')
  })
  it('cancels context paste when rectangle identity changes without moving the caret', async () => {
    let identity = {}
    const test = fixture('原文', { getSelectionIdentity: () => identity })
    let resolve!: (value: { text: string }) => void
    const pending = test.controller.paste(() => new Promise(done => { resolve = done }))
    identity = {}
    resolve({ text: '过期粘贴' })
    expect(await pending).toBe(false)
    expect(test.state.doc.toString()).toBe('原文')
  })
  it.each(['readonly', 'partial'] as const)('permits copy but forbids writes when %s', async mode => {
    const test = fixture('**文字**', { isPartial: () => mode === 'partial' }, mode === 'readonly')
    expect(test.controller.capabilities()).toEqual({ copy: true, copySource: true, cut: false, paste: false })
    expect(await test.controller.copy()).toBe(true)
    expect(await test.controller.cut()).toBe(false)
    expect(test.controller.pastePayload({ text: '不能写' })).toBe(false)
    expect(test.state.doc.toString()).toBe('**文字**')
  })
  it('cuts only after a successful clipboard write, using the shared undo history', async () => {
    const test = fixture('# 标题')
    expect(await test.controller.cut()).toBe(true)
    expect(test.writes).toEqual(['标题'])
    expect(test.state.doc.toString()).toBe('')
    expect(undo(test.view)).toBe(true)
    expect(test.state.doc.toString()).toBe('# 标题')
    expect(redo(test.view)).toBe(true)
    expect(test.state.doc.toString()).toBe('')
    const rejected = fixture('保留', { writeText: async () => { throw new Error('denied') } })
    await expect(rejected.controller.cut()).rejects.toThrow('denied')
    expect(rejected.state.doc.toString()).toBe('保留')
  })
  it.each(['deactivate', 'identity', 'revision', 'invalidate', 'destroy', 'selection'] as const)('cancels pending paste after %s', async change => {
    let active = true, identity = 'A', revision = 0
    const test = fixture('原文', { isActive: () => active, getDocumentIdentity: () => identity, getRevision: () => revision })
    let resolve!: (value: { text: string }) => void
    const pending = test.controller.paste(() => new Promise(done => { resolve = done }))
    if (change === 'deactivate') active = false
    if (change === 'identity') identity = 'B'
    if (change === 'revision') revision++
    if (change === 'invalidate') test.controller.invalidate()
    if (change === 'destroy') test.controller.destroy()
    if (change === 'selection') test.view.dispatch({ selection: { anchor: 1 } })
    resolve({ text: '迟到内容' })
    expect(await pending).toBe(false)
    expect(test.state.doc.toString()).toBe('原文')
  })
  it('lets rectangular table handlers claim clipboard events before text handling', () => {
    const test = fixture('原文', { claimEvent: () => true })
    let prevented = false
    const event = { preventDefault() { prevented = true } } as ClipboardEvent
    expect(test.controller.handleCopy(event)).toBe(true)
    expect(test.controller.handlePaste(event)).toBe(true)
    expect(prevented).toBe(true)
    expect(test.writes).toEqual([])
    expect(test.state.doc.toString()).toBe('原文')
  })
  it('uses the event receiver, never IPC or navigator, for native copy/cut/paste', () => {
    const test = fixture('# 标题')
    const receiver = new Map<string, string>()
    // Browser copy/cut/paste are separate events sharing one data receiver.
    const event = () => ({ defaultPrevented: false, clipboardData: { types: ['text/plain'], files: [], setData(type: string, text: string) { receiver.set(type, text) }, getData(type: string) { return receiver.get(type) || '' } }, preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true } }) as unknown as ClipboardEvent
    expect(test.controller.handleCopy(event())).toBe(true)
    expect([...receiver]).toEqual([['text/plain', '标题']])
    expect(test.controller.handleCut(event())).toBe(true)
    expect(test.state.doc.toString()).toBe('')
    expect(test.controller.handlePaste(event())).toBe(true)
    expect(test.state.doc.toString()).toBe('标题')
    expect(test.writes).toEqual([])
  })
  it.each([['Files'], ['image/png'], ['public.tiff']])('leaves native %s paste to media', type => {
    const test = fixture('原文')
    let prevented = false
    const event = { clipboardData: { types: [type], files: [] }, preventDefault() { prevented = true } } as unknown as ClipboardEvent
    expect(test.controller.handlePaste(event)).toBe(false)
    expect(prevented).toBe(false)
    expect(test.state.doc.toString()).toBe('原文')
  })
  it('sourceOnly copies and pastes literal source, without interpreting HTML', async () => {
    const test = fixture('# 原样\n\n**粗体**', { sourceOnly: () => true })
    await test.controller.copy()
    expect(test.writes).toEqual(['# 原样\n\n**粗体**'])
    expect(test.controller.pastePayload({ text: '<b>原文</b>', html: '<b>不解析</b>' })).toBe(true)
    expect(test.state.doc.toString()).toBe('<b>原文</b>')
  })
})
