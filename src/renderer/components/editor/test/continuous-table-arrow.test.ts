import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { handleContinuousTableArrow } from '../continuousMarkdownTable'

function fixture(marked: string, readOnly = false) {
  const anchor = marked.indexOf('¦'), source = marked.replace('¦', '')
  let state = EditorState.create({ doc: source, selection: { anchor }, extensions: [
    markdown({ base: markdownLanguage }), EditorState.readOnly.of(readOnly),
  ] })
  const transactions: TransactionSpec[] = []
  const view = { get state() { return state }, dispatch(spec: TransactionSpec) {
    transactions.push(spec); state = state.update(spec).state
  } } as Pick<EditorView, 'state' | 'dispatch'>
  return { view, source, transactions, marked: () => state.sliceDoc(0, state.selection.main.head) + '¦' + state.sliceDoc(state.selection.main.head) }
}

describe('continuous table horizontal navigation', () => {
  it.each(['|  |¦  |  |', '|  | ¦ |  |', '|  |  ¦|  |'])('skips all empty-cell padding on ArrowRight: %s', row => {
    const f = fixture(row + '\n| --- | --- | --- |')
    expect(handleContinuousTableArrow(f.view, false)).toBe(true)
    expect(f.marked()).toBe('|  |  |  ¦|\n| --- | --- | --- |')
    expect(f.view.state.selection.main.assoc).toBe(-1)
    expect(f.transactions.every(tr => !f.view.state.update(tr).docChanged)).toBe(true)
  })
  it.each(['|  |¦  |  |', '|  | ¦ |  |', '|  |  ¦|  |'])('skips all empty-cell padding on ArrowLeft: %s', row => {
    const f = fixture(row + '\n| --- | --- | --- |')
    expect(handleContinuousTableArrow(f.view, true)).toBe(true)
    expect(f.marked()).toBe('|  ¦|  |  |\n| --- | --- | --- |')
    expect(f.view.state.doc.toString()).toBe(f.source)
  })
  it('enters the first cell directly from preceding prose without a blank-line stop', () => {
    const f = fixture('before¦\n\n| A | B |\n| --- | --- |\n|  | C |\n\nafter')
    expect(handleContinuousTableArrow(f.view, false)).toBe(true)
    expect(f.marked()).toBe('before\n\n| ¦A | B |\n| --- | --- |\n|  | C |\n\nafter')
  })
  it.each([
    ['before\n\n| A | B¦ |\n| --- | --- |\n|  | C |\n\nafter', false, 'before\n\n| A | B |\n| --- | --- |\n|  ¦| C |\n\nafter'],
    ['before\n\n| A | B |\n| --- | --- |\n| ¦ | C |\n\nafter', true, 'before\n\n| A | B¦ |\n| --- | --- |\n|  | C |\n\nafter'],
    ['before\n\n| ¦A | B |\n| --- | --- |\n|  | C |\n\nafter', true, 'before¦\n\n| A | B |\n| --- | --- |\n|  | C |\n\nafter'],
    ['before\n\n| A | B |\n| --- | --- |\n|  | C¦ |\n\nafter', false, 'before\n\n| A | B |\n| --- | --- |\n|  | C |\n\n¦after'],
    ['before\n\n| A | B |\n| --- | --- |\n|  | C |\n\n¦after', true, 'before¦\n\n| A | B |\n| --- | --- |\n|  | C |\n\nafter'],
  ] as const)('matches ordinary row and prose boundaries: %s', (source, backward, expected) => {
    const f = fixture(source)
    expect(handleContinuousTableArrow(f.view, backward)).toBe(true)
    expect(f.marked()).toBe(expected)
    expect(f.view.state.doc.toString()).toBe(f.source)
  })
  it.each([true, false])('leaves interior grapheme movement to native commands: %s', backward => {
    const f = fixture('| Aé¦👩‍💻 | B |\n| --- | --- |')
    expect(handleContinuousTableArrow(f.view, backward)).toBe(false)
    expect(f.transactions).toHaveLength(0)
  })
  it('allows read-only table navigation without writing source', () => {
    const f = fixture('|  |¦  |  |\n| --- | --- | --- |', true)
    expect(handleContinuousTableArrow(f.view, false)).toBe(true)
    expect(f.marked()).toBe('|  |  |  ¦|\n| --- | --- | --- |')
    expect(f.view.state.doc.toString()).toBe(f.source)
  })
  it('leaves noncollapsed selections to native commands', () => {
    const f = fixture('| ab¦c | B |\n| --- | --- |')
    f.view.dispatch({ selection: { anchor: 2, head: 3 } }); f.transactions.length = 0
    expect(handleContinuousTableArrow(f.view, false)).toBe(false)
    expect(f.transactions).toHaveLength(0)
  })
})
