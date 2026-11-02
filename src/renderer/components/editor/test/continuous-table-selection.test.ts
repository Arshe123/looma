import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { EditorView } from '@codemirror/view'
import { continuousTableSelectionState, selectContinuousTableRectangle, getContinuousTableSelection, replaceContinuousTableSelection, readContinuousTableSelection, pasteContinuousTableSelection } from '../continuousMarkdownTableSelection'

const source = '| A | B | C |\n| --- | --- | --- |\n| d | e | f |\n| g | h | i |'
function fixture(text = source, readOnly = false) {
  let state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage }), continuousTableSelectionState, EditorState.readOnly.of(readOnly)] })
  const transactions: TransactionSpec[] = []
  const view = { get state() { return state }, dispatch(spec: TransactionSpec) { transactions.push(spec); state = state.update(spec).state } } as Pick<EditorView, 'state' | 'dispatch'>
  return { view, transactions, text: () => state.doc.toString() }
}
describe('source-backed rectangular table selection', () => {
  it('selects a rectangle without linear ranges, skipping the separator', () => {
    const f = fixture()
    expect(selectContinuousTableRectangle(f.view, source.indexOf('A'), 0, source.indexOf('h'), 1)).toBe(true)
    expect(getContinuousTableSelection(f.view.state)).not.toBeNull()
    expect(f.view.state.selection.main.empty).toBe(true)
    expect(f.view.state.selection.ranges).toHaveLength(1)
    expect(readContinuousTableSelection(f.view.state)?.rows).toEqual([['A', 'B'], ['d', 'e'], ['g', 'h']])
    expect(f.text()).toBe(source)
  })
  it('paste tiles a grid from top-left regardless of head direction, unlike typing', () => {
    const f = fixture()
    selectContinuousTableRectangle(f.view, source.indexOf('h'), 1, source.indexOf('A'), 0)
    pasteContinuousTableSelection(f.view, [['P','Q'],['R','S']])
    expect(readContinuousTableSelection(f.view.state)?.rows).toEqual([['P','Q'],['R','S'],['P','Q']])
    expect(f.transactions.filter(transaction => transaction.changes)).toHaveLength(1)
  })
  it('plain paste fills every selected cell (ordinary CellSelection oracle)', () => {
    const f = fixture()
    selectContinuousTableRectangle(f.view, source.indexOf('A'), 0, source.indexOf('h'), 1)
    pasteContinuousTableSelection(f.view, [['X']])
    expect(readContinuousTableSelection(f.view.state)?.rows).toEqual([['X','X'],['X','X'],['X','X']])
  })
  it('reverse rectangle inserts in head and clears all selected cells in one write', () => {
    const f = fixture()
    selectContinuousTableRectangle(f.view, source.indexOf('h'), 1, source.indexOf('A'), 0)
    expect(readContinuousTableSelection(f.view.state)?.rows).toEqual([['A','B'],['d','e'],['g','h']])
    expect(replaceContinuousTableSelection(f.view, 'X')).toBe(true)
    expect(f.text()).toBe('| X |  | C |\n| --- | --- | --- |\n|  |  | f |\n|  |  | i |')
    expect(getContinuousTableSelection(f.view.state)).toBeNull()
    expect(f.transactions.filter(transaction => transaction.changes)).toHaveLength(1)
  })
  it.each([['\\|', '\\|'], ['\\\\|', '\\\\\\|'], ['a\\|b', 'a\\|b']])('preserves escaped pipe parity when pasting %s', (input, encoded) => {
    const f = fixture()
    selectContinuousTableRectangle(f.view, source.indexOf('A'), 0, source.indexOf('h'), 1)
    pasteContinuousTableSelection(f.view, [[input]])
    expect(readContinuousTableSelection(f.view.state)?.rows).toEqual([[encoded, encoded], [encoded, encoded], [encoded, encoded]])
  })
  it('clear preserves separator, outside cells and quoted row prefixes', () => {
    const text = '> | A | B | C |\n> | --- | --- | --- |\n> | d | e | f |'
    const f = fixture(text)
    selectContinuousTableRectangle(f.view, text.indexOf('A'), 0, text.indexOf('e'), 1)
    replaceContinuousTableSelection(f.view, '', true)
    expect(f.text()).toBe('> |  |  | C |\n> | --- | --- | --- |\n> |  |  | f |')
    expect(readContinuousTableSelection(f.view.state)?.rows).toEqual([['',''],['','']])
  })
  it('materializes explicit edge pipes when clearing implicit cells', () => {
    const text = 'A | B\n--- | ---\nd | e', f = fixture(text)
    selectContinuousTableRectangle(f.view, 0, 0, text.indexOf('e'), 1)
    expect(replaceContinuousTableSelection(f.view, '', true)).toBe(true)
    expect(readContinuousTableSelection(f.view.state)?.rows).toEqual([['',''],['','']])
  })
  it('clearing implicit first cells keeps the caret inside the head cell', () => {
    const text = 'A | B\n--- | ---\nd | e', f = fixture(text)
    selectContinuousTableRectangle(f.view, text.indexOf('e'), 1, 0, 0)
    replaceContinuousTableSelection(f.view, '', true)
    expect(f.view.state.selection.main.head).toBe(1)
    expect(getContinuousTableSelection(f.view.state)?.caret).toBe(1)
  })
  it('readOnly permits selection/copy but rejects clear/type', () => {
    const f = fixture(source, true)
    selectContinuousTableRectangle(f.view, source.indexOf('A'), 0, source.indexOf('e'), 1)
    expect(readContinuousTableSelection(f.view.state)?.rows).toHaveLength(2)
    expect(replaceContinuousTableSelection(f.view, 'bad')).toBe(true)
    expect(f.text()).toBe(source)
  })
  it('rejects separator, non-table and out of range endpoints', () => {
    const f = fixture(source + '\n\noutside')
    expect(selectContinuousTableRectangle(f.view, 0, 0, source.indexOf('---'), 1)).toBe(false)
    expect(selectContinuousTableRectangle(f.view, 0, 0, source.length + 2, 1)).toBe(false)
    expect(selectContinuousTableRectangle(f.view, 0, 0, source.indexOf('e'), 8)).toBe(false)
  })
  it('foreign writes and cursor navigation invalidate metadata', () => {
    const f = fixture()
    selectContinuousTableRectangle(f.view, source.indexOf('A'), 0, source.indexOf('e'), 1)
    f.view.dispatch({ changes: { from: 0, insert: 'x' } })
    expect(getContinuousTableSelection(f.view.state)).toBeNull()
    selectContinuousTableRectangle(f.view, 2, 0, source.indexOf('e') + 1, 1)
    f.view.dispatch({ selection: { anchor: 0 } })
    expect(getContinuousTableSelection(f.view.state)).toBeNull()
  })
  it.each(['\\', '|', 'x\ny'])('replacement %s cannot damage structure', text => {
    const f = fixture('|A|B|\n|---|---|\n|d|e|')
    selectContinuousTableRectangle(f.view, 1, 0, 20, 1)
    replaceContinuousTableSelection(f.view, text)
    expect(selectContinuousTableRectangle(f.view, 1, 0, f.view.state.doc.line(3).from + 1, 1)).toBe(true)
    expect(readContinuousTableSelection(f.view.state)?.rows).toHaveLength(2)
  })
})
