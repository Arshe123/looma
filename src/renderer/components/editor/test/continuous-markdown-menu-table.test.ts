import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, undo } from '@codemirror/commands'
import { continuousToolbarTableSize, resizeContinuousToolbarTable } from '../continuousMarkdownMenuTable'
import { parsedMarkdownState } from './parsed-markdown-state'

const fixture = (doc: string) => {
  let state = parsedMarkdownState(EditorState.create({ doc, selection: { anchor: 2 }, extensions: [markdown({ base: markdownLanguage }), history()] }))
  return { get state() { return state }, dispatch: (spec: Parameters<EditorState['update']>[0]) => { state = parsedMarkdownState(state.update(spec).state) } }
}
describe('continuous table toolbar source adapter', () => {
  it('resizes one parsed table with existing source/alignment and one undoable transaction', () => {
    const source = '| **A** | B\\|C |\n| :--- | ---: |\n| D | E |\n\nafter'
    const view = fixture(source)
    expect(continuousToolbarTableSize(view.state)).toEqual({ rows: 2, cols: 2 })
    expect(resizeContinuousToolbarTable(view, 3, 3)).toBe(true)
    expect(view.state.doc.toString()).toBe('| **A** | B\\|C |  |\n| :--- | ---: | --- |\n| D | E |  |\n|  |  |  |\n\nafter')
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(source)
  })
  it('truncates dimensions explicitly and rejects unsupported dimensions/read-only/non-table selections', () => {
    const view = fixture('| A | B |\n| --- | --- |\n| C | D |')
    expect(resizeContinuousToolbarTable(view, 1, 1)).toBe(true)
    expect(view.state.doc.toString()).toBe('| A |\n| --- |')
    for (const rows of [0, -1, 100, 1.5, NaN]) expect(resizeContinuousToolbarTable(view, rows, 2)).toBe(false)
    const plain = fixture('plain')
    expect(continuousToolbarTableSize(plain.state)).toBe(null)
    expect(resizeContinuousToolbarTable(plain, 2, 2)).toBe(false)
    const readonly = parsedMarkdownState(EditorState.create({ doc: '| A |\n| --- |', extensions: [markdown(), EditorState.readOnly.of(true)] }))
    expect(resizeContinuousToolbarTable({ state: readonly, dispatch: () => { throw Error('read-only') } }, 2, 2)).toBe(false)
  })
})
