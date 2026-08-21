import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/vue-3'
import { describe, expect, it } from 'vitest'
import {
  changeRichTextIndent,
  EDITOR_INDENT,
  shouldDeferRichTextTab,
} from '../tiptap-indentation'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
})

const createEditor = (paragraphs: string[], selection?: { from: number; to?: number }) => {
  const nodes = paragraphs.map(text => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined))
  let state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, nodes) })
  if (selection) {
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, selection.from, selection.to)))
  }
  const editor = {
    isDestroyed: false,
    get state() { return state },
    view: {
      dispatch(transaction: Parameters<typeof state.apply>[0]) {
        state = state.apply(transaction)
      },
    },
  } as unknown as Editor
  return { editor, getState: () => state }
}

const createCodeBlockEditor = (text: string, selection: { from: number; to?: number }) => {
  const codeSchema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      codeBlock: { content: 'text*', group: 'block', code: true },
      text: { group: 'inline' },
    },
  })
  const codeBlock = codeSchema.nodes.codeBlock.create(null, text ? codeSchema.text(text) : undefined)
  let state = EditorState.create({
    schema: codeSchema,
    doc: codeSchema.nodes.doc.create(null, codeBlock),
  })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, selection.from, selection.to)))
  const editor = {
    isDestroyed: false,
    get state() { return state },
    view: {
      dispatch(transaction: Parameters<typeof state.apply>[0]) {
        state = state.apply(transaction)
      },
    },
  } as unknown as Editor
  return { editor, getState: () => state }
}

describe('rich text indentation', () => {
  it('uses the same four-space indentation unit as CodeMirror', () => {
    const { editor, getState } = createEditor(['alpha'], { from: 3 })

    expect(changeRichTextIndent(editor, 'more')).toBe(true)
    expect(getState().doc.child(0).textContent).toBe(`${EDITOR_INDENT}alpha`)
    expect(getState().selection.from).toBe(7)
  })

  it('removes one indentation unit from the current text block', () => {
    const { editor, getState } = createEditor(['    alpha'], { from: 7 })

    expect(changeRichTextIndent(editor, 'less')).toBe(true)
    expect(getState().doc.child(0).textContent).toBe('alpha')
  })

  it('indents every selected text block and excludes a block at the selection end', () => {
    const { editor, getState } = createEditor(['alpha', 'beta', 'gamma'], { from: 2, to: 14 })

    expect(changeRichTextIndent(editor, 'more')).toBe(true)
    expect(getState().doc.content.content.map(node => node.textContent)).toEqual(['    alpha', '    beta', 'gamma'])
  })

  it('normalizes a leading tab by one CodeMirror indentation unit', () => {
    const { editor, getState } = createEditor(['\talpha'], { from: 3 })

    expect(changeRichTextIndent(editor, 'less')).toBe(true)
    expect(getState().doc.child(0).textContent).toBe('alpha')
  })

  it('consumes outdent when no indentation can be removed', () => {
    const { editor, getState } = createEditor(['alpha'], { from: 3 })

    expect(changeRichTextIndent(editor, 'less')).toBe(true)
    expect(getState().doc.child(0).textContent).toBe('alpha')
  })

  it('indents the current line instead of the first line in a code block', () => {
    const { editor, getState } = createCodeBlockEditor('first\nsecond\nthird', { from: 10 })

    expect(changeRichTextIndent(editor, 'more')).toBe(true)
    expect(getState().doc.child(0).textContent).toBe('first\n    second\nthird')
    expect(getState().selection.from).toBe(14)
  })

  it('outdents the current line in a code block', () => {
    const { editor, getState } = createCodeBlockEditor('    first\n    second', { from: 18 })

    expect(changeRichTextIndent(editor, 'less')).toBe(true)
    expect(getState().doc.child(0).textContent).toBe('    first\nsecond')
  })

  it('indents all selected code-block lines and excludes an ending line boundary', () => {
    const { editor, getState } = createCodeBlockEditor('first\nsecond\nthird', { from: 3, to: 14 })

    expect(changeRichTextIndent(editor, 'more')).toBe(true)
    expect(getState().doc.child(0).textContent).toBe('    first\n    second\nthird')
  })

  it('does not defer plain paragraphs to Tiptap structural shortcuts', () => {
    const { editor } = createEditor(['alpha'], { from: 2 })
    expect(shouldDeferRichTextTab(editor)).toBe(false)
  })

  it('defers list items to the built-in Tiptap shortcuts', () => {
    const listSchema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'inline*', group: 'block' },
        bulletList: { content: 'listItem+', group: 'block' },
        listItem: { content: 'paragraph block*' },
        text: { group: 'inline' },
      },
    })
    const paragraph = listSchema.nodes.paragraph.create(null, listSchema.text('alpha'))
    const listItem = listSchema.nodes.listItem.create(null, paragraph)
    const doc = listSchema.nodes.doc.create(null, listSchema.nodes.bulletList.create(null, listItem))
    const state = EditorState.create({
      schema: listSchema,
      doc,
      selection: TextSelection.create(doc, 4),
    })
    const editor = { state } as unknown as Editor

    expect(shouldDeferRichTextTab(editor)).toBe(true)
  })
})
