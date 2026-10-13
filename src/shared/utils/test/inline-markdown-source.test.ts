import { describe, expect, it } from 'vitest'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { getSchema } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { undoDepth, history, undo, redo } from '@tiptap/pm/history'
import { ResizableMarkdownImage } from '../resizable-markdown-image'
import { InlineMarkdown, createInlineMarkdownPlugin, inlineMarkdownKey, getInlineMarkdownSpans, hasInlineMarkdownSource, getInlineMarkdownLinkAtPosition, isInlineMarkdownCodeAtPosition, toggleInlineMarkdownFormat } from '../tiptap-inline-markdown'

const manager = () => new MarkdownManager({ extensions: [StarterKit, InlineMarkdown] })
const fixture = (source: string, from = 1, to = from) => {
  const schema = getSchema([StarterKit])
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON(manager().parse(source)), plugins: [history(), createInlineMarkdownPlugin()] })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)))
  const editor = { get state() { return state }, view: { dispatch(tr: import('@tiptap/pm/state').Transaction) { state = state.apply(tr) } } }
  return editor
}

describe('source format commands and lookup', () => {
  it('classifies clipboard source with the lexer', () => {
    expect(hasInlineMarkdownSource('**yes**')).toBe(true)
    expect(hasInlineMarkdownSource('**not closed')).toBe(false)
    expect(hasInlineMarkdownSource('plain')).toBe(false)
  })
  it.each([['bold', '**'], ['italic', '*'], ['strike', '~~'], ['highlight', '=='], ['inlineCode', '`']] as const)('toggles %s in one history event without marks', (type, delimiter) => {
    const editor = fixture('hello', 1, 6)
    expect(toggleInlineMarkdownFormat(editor, type)).toBe(true)
    expect(editor.state.doc.textContent).toBe(`${delimiter}hello${delimiter}`)
    expect(undoDepth(editor.state)).toBe(1)
    expect(editor.state.doc.firstChild!.firstChild!.marks).toHaveLength(0)
    expect(toggleInlineMarkdownFormat(editor, type)).toBe(true)
    expect(editor.state.doc.textContent).toBe('hello')
  })
  it('inserts paired syntax and places a collapsed cursor inside', () => {
    const editor = fixture('hello', 3)
    toggleInlineMarkdownFormat(editor, 'bold')
    expect(editor.state.doc.textContent).toBe('he****llo')
    expect(editor.state.selection.from).toBe(5)
    expect(editor.state.selection.empty).toBe(true)
  })
  it('unwraps an enclosing format without deleting nested syntax', () => {
    const editor = fixture('**outer *inner* end**', 10)
    toggleInlineMarkdownFormat(editor, 'bold')
    expect(editor.state.doc.textContent).toBe('outer *inner* end')
    expect(editor.state.selection.from).toBe(8)
  })
  it('uses a longer code delimiter when selected text contains backticks', () => {
    const editor = fixture('a`b', 1, 4)
    toggleInlineMarkdownFormat(editor, 'inlineCode')
    expect(editor.state.doc.textContent).toBe('``a`b``')
    expect(getInlineMarkdownSpans(editor.state.doc.textContent)[0]?.type).toBe('inlineCode')
  })
  it('looks up raw nested links even while source is visible', () => {
    const source = '[**nested** label](note.md#L2 "title")'
    const editor = fixture(`a ${source} z`, 8)
    expect(getInlineMarkdownLinkAtPosition(editor.state)).toMatchObject({ from: 3, to: 3 + source.length, href: 'note.md#L2', source, label: '**nested** label', title: 'title' })
    expect(getInlineMarkdownSpans(source).map(s => s.type)).toEqual(['link', 'bold'])
  })
  it.each(['`[[`', '``a` [[', '`open [['])('recognizes code and open backticks: %s', source => {
    const editor = fixture(source, source.length)
    expect(isInlineMarkdownCodeAtPosition(editor.state)).toBe(true)
  })
  it('does not interpret an escaped backtick as opening code', () => {
    const editor = fixture('\\` plain', 9)
    expect(isInlineMarkdownCodeAtPosition(editor.state)).toBe(false)
  })
  it('normalizes externally applied marks in the same undo event', () => {
    const editor = fixture('hello', 1, 6)
    const transaction = editor.state.tr.addMark(1, 6, editor.state.schema.marks.bold.create())
    const next = editor.state.applyTransaction(transaction).state
    expect(next.doc.textContent).toBe('**hello**')
    expect(next.doc.firstChild!.firstChild!.marks).toHaveLength(0)
    expect(undoDepth(next)).toBe(1)
  })
  it('preserves nested pasted link/title and bold mark source', () => {
    const editor = fixture('hello', 1, 6)
    const next = editor.state.applyTransaction(editor.state.tr
      .addMark(1, 6, editor.state.schema.marks.link.create({ href: 'note.md', title: 'a title' }))
      .addMark(1, 6, editor.state.schema.marks.bold.create())).state
    expect(next.doc.textContent).toBe('[**hello**](note.md "a title")')
    expect(getInlineMarkdownSpans(next.doc.textContent).map(s => s.type)).toEqual(['link', 'bold'])
  })
})

describe('permanent inline Markdown source', () => {
  it('keeps structural image, break and HTML parsing delegated to Tiptap', () => {
    const extensions = [StarterKit, ResizableMarkdownImage]
    const md = new MarkdownManager({ extensions: [...extensions, InlineMarkdown] })
    expect(md.parse('![图](image.png "title"){width=60%}').content?.[0]).toMatchObject({ type: 'image', attrs: { src: 'image.png', title: 'title', widthPercent: 60 } })
    expect(md.parse('a  \nb').content?.[0]?.content?.map(node => node.type)).toEqual(['text', 'hardBreak', 'text'])
    // MarkdownManager's node-environment HTML fallback keeps these tags as
    // text; browser HTML parsing remains covered by the Electron harness.
    expect(getSchema(extensions).nodeFromJSON(md.parse('a <span>plain</span> z')).textContent).toBe('a <span>plain</span> z')
    for (const source of ['![图](image.png "title"){width=60%}', 'a  \nb', '# heading\n\n> quote\n\n- item\n\n```html\n<literal>&\n```']) {
      let saved = source
      const original = md.parse(source)
      for (let round = 0; round < 3; round++) {
        saved = md.serialize(md.parse(saved))
        expect(md.parse(saved)).toEqual(original)
      }
    }
  })

  it('resolves nested references and escaped titles without losing source', () => {
    const md = manager()
    let saved = '**[说明][ref]**\n\n[ref]: target.md?q=1&b=2 "标题 \\"引号\\""'
    for (let round = 0; round < 3; round++) {
      saved = md.serialize(md.parse(saved))
      expect(saved).toBe('**[说明](target.md?q=1&b=2 "标题 \\"引号\\"")**')
      expect(getInlineMarkdownSpans(saved).find(span => span.type === 'link')).toMatchObject({ href: 'target.md?q=1&b=2', title: '标题 "引号"' })
    }
  })

  it.each(['[说明][ref]', '[ref][]', '[ref]', '[**说明**][ref]'])('resolves reference links with document definitions: %s', link => {
    const md = manager()
    const label = link === '[ref][]' || link === '[ref]' ? 'ref' : link === '[**说明**][ref]' ? '**说明**' : '说明'
    const canonical = `a [${label}](target.md#L12 "标题") z`
    let saved = `a ${link} z\n\n[ref]: target.md#L12 "标题"`
    for (let round = 0; round < 3; round++) {
      const parsed = md.parse(saved)
      const schema = getSchema([StarterKit])
      const doc = schema.nodeFromJSON(parsed)
      expect(doc.textContent).toBe(canonical)
      const state = EditorState.create({ schema, doc })
      expect(getInlineMarkdownLinkAtPosition(state, 5)).toMatchObject({ href: 'target.md#L12', title: '标题', label })
      saved = md.serialize(parsed)
      expect(saved).toBe(canonical)
    }
  })

  it.each([
    'a < b && c > d',
    'a `a < b && c > d` z',
    'a &amp; &#38; &lt; z',
    'a <https://example.com?q=1&b=2> z',
    'a &amp; [查询](https://example.com?q=1&b=2) z',
  ])('preserves source without cumulative HTML escaping: %s', source => {
    const md = manager()
    let saved = source
    for (let round = 0; round < 3; round++) {
      const parsed = md.parse(saved)
      expect(getSchema([StarterKit]).nodeFromJSON(parsed).textContent).toBe(source)
      saved = md.serialize(parsed)
      expect(saved).toBe(source)
    }
  })

  it('freezes layout while dragging a cross-region selection until pointer release', () => {
    const editor = fixture('a **bold** z', 1)
    let state = editor.state.apply(editor.state.tr.setMeta(inlineMarkdownKey, { focused: true, dragging: true }))
    const frozen = inlineMarkdownKey.getState(state)!.decorations
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 10)))
    expect(inlineMarkdownKey.getState(state)!.decorations).toBe(frozen)
    state = state.apply(state.tr.setMeta(inlineMarkdownKey, { dragging: false }))
    expect(inlineMarkdownKey.getState(state)!.decorations.find().filter(d => !d.spec.inlineHighlight && !d.spec.inlineHighlightBlock)).toHaveLength(0)
    expect(undoDepth(state)).toBe(0)
  })

  it('keeps existing note/external link icon classes on rendered links', () => {
    const editor = fixture('[笔记](note.md) [网站](https://example.com)')
    const decorations = inlineMarkdownKey.getState(editor.state)!.decorations.find()
    const attrs = decorations.map(d => (d as unknown as { type: { attrs?: Record<string, string> } }).type.attrs)
    expect(attrs.some(a => a?.class === 'looma-note-ref')).toBe(true)
    expect(attrs.some(a => a?.class === 'looma-external-link')).toBe(true)
  })

  it('reveals the entire enclosing inline fragment, including nested syntax away from the caret', () => {
    for (const source of ['a **outer *inner* end** z', 'a [label **bold**](note.md) z']) {
      const editor = fixture(source, 4)
      const state = editor.state.apply(editor.state.tr.setMeta(inlineMarkdownKey, { focused: true }))
      expect(inlineMarkdownKey.getState(state)!.decorations.find().filter(d => !d.spec.inlineHighlight && !d.spec.inlineHighlightBlock)).toHaveLength(0)
    }
  })

  it('keeps bold delimiters as document text, without changing blocks', () => {
    const md = manager()
    const doc = md.parse('# A **bold** heading\n\n> A **bold** quote')
    expect(doc.content?.[0]).toEqual({ type: 'heading', attrs: { level: 1 }, content: [
      { type: 'text', text: 'A ' }, { type: 'text', text: '**bold**' }, { type: 'text', text: ' heading' },
    ] })
    expect(doc.content?.[1]?.type).toBe('blockquote')
    expect(md.serialize(doc)).toBe('# A **bold** heading\n\n> A **bold** quote')
  })
  it('reveals genuinely editable delimiters at either boundary using decorations only', () => {
    const schema = getSchema([StarterKit])
    let state = EditorState.create({
      schema, doc: schema.nodeFromJSON(manager().parse('a **bold** z')),
      plugins: [history(), createInlineMarkdownPlugin()],
    })
    const original = state.doc
    const hidden = () => inlineMarkdownKey.getState(state)!.decorations.find().filter(d => d.spec.syntax)
    expect(hidden()).toHaveLength(2)
    for (const pos of [3, 4, 7, 10, 11]) {
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)).setMeta(inlineMarkdownKey, { focused: true }))
      expect(hidden()).toHaveLength(0)
      expect(state.doc).toBe(original)
      expect(undoDepth(state)).toBe(0)
    }
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 12)))
    expect(hidden()).toHaveLength(2)
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 10)).insertText('!'))
    expect(state.doc.textContent).toBe('a **bold*!* z')
  })
  it('keeps undo/redo valid after display changes and mark normalization', () => {
    const editor = fixture('hello', 1, 6)
    let state = editor.state.applyTransaction(editor.state.tr.addMark(1, 6, editor.state.schema.marks.bold.create())).state
    state = state.applyTransaction(state.tr.setMeta(inlineMarkdownKey, { focused: true })).state
    undo(state, tr => { state = state.applyTransaction(tr).state })
    expect(state.doc.textContent).toBe('hello')
    redo(state, tr => { state = state.applyTransaction(tr).state })
    expect(state.doc.textContent).toBe('**hello**')
  })
  it('freezes syntax during composition and rebuilds afterward without history', () => {
    const editor = fixture('**hello**', 5)
    let state = editor.state.apply(editor.state.tr.setMeta(inlineMarkdownKey, { composing: true }))
    const frozen = inlineMarkdownKey.getState(state)!.decorations
    state = state.apply(state.tr.setMeta(inlineMarkdownKey, { focused: true }))
    expect(inlineMarkdownKey.getState(state)!.decorations).toBe(frozen)
    state = state.apply(state.tr.setMeta(inlineMarkdownKey, { composing: false }))
    expect(inlineMarkdownKey.getState(state)!.decorations.find().filter(d => !d.spec.inlineHighlight && !d.spec.inlineHighlightBlock)).toHaveLength(0)
    expect(undoDepth(state)).toBe(0)
  })
  it('preserves fenced code and blockquote nodes', () => {
    const md = manager()
    const source = '> *hello*\n\n```ts\n**literal**\n```'
    const parsed = md.parse(source)
    expect(parsed.content?.map(n => n.type)).toEqual(['blockquote', 'codeBlock'])
    expect(md.serialize(parsed)).toBe(source)
  })
  it.each(['*italic*', '~~strike~~', '==highlight==', '`code`', '`` a`b ``', '[**nested** label](note.md#L2 "title")', '**outer *inner* end**', '**one***two*', '\\*literal\\*', '***both***', '__under__', '_italic_', '中文**“强调”**中文'])('keeps %s source and renders only complete inline syntax', source => {
    const md = manager()
    const parsed = md.parse(`a ${source} z`)
    const schema = getSchema([StarterKit])
    const doc = schema.nodeFromJSON(parsed)
    expect(doc.textContent).toBe(`a ${source} z`)
    expect(md.serialize(parsed)).toBe(`a ${source} z`)
    const state = EditorState.create({ schema, doc, plugins: [createInlineMarkdownPlugin()] })
    expect(inlineMarkdownKey.getState(state)!.decorations.find().some(d => d.spec.syntax)).toBe(true)
  })
})
