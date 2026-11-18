import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { history, undoDepth } from '@tiptap/pm/history'
import { createInlineMarkdownPlugin, inlineMarkdownKey } from '../tiptap-inline-markdown'

const schema = getSchema([StarterKit])
const fixture = (source: string) => EditorState.create({
  schema, doc: schema.node('doc', null, [schema.node('paragraph', null, schema.text(source))]),
  plugins: [history(), createInlineMarkdownPlugin()],
})
const highlights = (state: EditorState) => inlineMarkdownKey.getState(state)!.decorations.find().filter(d => d.spec.inlineHighlight)
const blocks = (state: EditorState) => inlineMarkdownKey.getState(state)!.decorations.find().filter(d => d.spec.inlineHighlightBlock)
const focus = (state: EditorState, from: number, to = from) => state.apply(state.tr
  .setSelection(TextSelection.create(state.doc, from, to)).setMeta(inlineMarkdownKey, { focused: true }))

describe('expanded inline source highlight', () => {
  it('keeps inline syntax collapsed across gaps and textblocks in a text selection', () => {
    const first = 'a **bold** gap `code` z'
    const second = 'b [link](note.md) end'
    const state = EditorState.create({ schema, doc: schema.node('doc', null,
      [first, second].map(text => schema.node('paragraph', null, schema.text(text)))), plugins: [createInlineMarkdownPlugin()] })
    const selected = focus(state, 4, state.doc.content.size - 2)
    expect(highlights(selected)).toHaveLength(0)
    expect(blocks(selected)).toHaveLength(0)
    expect(inlineMarkdownKey.getState(selected)!.decorations.find().filter(d => d.spec.syntax)).toHaveLength(6)
    expect(selected.doc).toBe(state.doc)
  })
  it.each(['**bold**', '*italic*', '~~strike~~', '==highlight==', '`code`', '[label](note.md)', '**outer *inner* end**'])('only expands %s for a collapsed caret, not forward/reverse selections', source => {
    const original = fixture(`a ${source} z`)
    const expanded = focus(original, 6)
    expect(highlights(expanded)).toHaveLength(1)
    for (const [from, to] of [[5, 6], [6, 5], [1, original.doc.content.size - 1]]) {
      const selected = focus(expanded, from, to)
      expect(highlights(selected)).toHaveLength(0)
      expect(blocks(selected)).toHaveLength(0)
      expect(inlineMarkdownKey.getState(selected)!.decorations.find().some(d => d.spec.syntax)).toBe(true)
      expect(selected.doc).toBe(original.doc)
      expect(undoDepth(selected)).toBe(0)
      expect(highlights(focus(selected, 6))).toHaveLength(1)
    }
  })
  it.each(['composing', 'dragging'])('freezes highlight and block suppression together while %s', mode => {
    let state = focus(fixture('a **bold** z'), 6)
    const frozen = inlineMarkdownKey.getState(state)!.decorations
    state = state.apply(state.tr.setMeta(inlineMarkdownKey, { [mode]: true }))
    state = focus(state, 1)
    expect(inlineMarkdownKey.getState(state)!.decorations).toBe(frozen)
    expect(highlights(state)).toHaveLength(1)
    expect(blocks(state)).toHaveLength(1)
    state = state.apply(state.tr.setMeta(inlineMarkdownKey, { [mode]: false }))
    expect(highlights(state)).toHaveLength(0)
    expect(blocks(state)).toHaveLength(0)
    expect(undoDepth(state)).toBe(0)
  })
  it('never decorates fenced code as expanded inline source', () => {
    const state = EditorState.create({ schema, doc: schema.node('doc', null,
      [schema.node('codeBlock', null, schema.text('**literal**'))]), plugins: [createInlineMarkdownPlugin()] })
    const selected = focus(state, 5)
    expect(highlights(selected)).toHaveLength(0)
    expect(blocks(selected)).toHaveLength(0)
  })
  it.each(['**bold**', '`code`', '[label](note.md#L2 "title")', '**outer *inner* end**', '[**bold**](note.md)'])('highlights only the complete outer source: %s', source => {
    const original = fixture(`a ${source} z`)
    const state = focus(original, 6)
    expect(highlights(state).map(d => [d.from, d.to])).toEqual([[3, 3 + source.length]])
    expect(blocks(state).map(d => [d.from, d.to])).toEqual([[0, state.doc.firstChild!.nodeSize]])
    expect(state.doc).toBe(original.doc)
    expect(undoDepth(state)).toBe(0)
    expect(highlights(focus(state, 1))).toHaveLength(0)
    expect(blocks(focus(state, 1))).toHaveLength(0)
    expect(highlights(state.apply(state.tr.setMeta(inlineMarkdownKey, { focused: false })))).toHaveLength(0)
  })
})
