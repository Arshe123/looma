import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { ensureSyntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { ChunkedDocument } from '../../../../shared/utils/chunked-document'
import { getContinuousTableContext, insertContinuousTable, runContinuousTableCommand } from '../continuousMarkdownTable'

function fixture(source: string, needle = 'x', readOnly = false) {
  let state = EditorState.create({ doc: source, selection: { anchor: Math.max(0, source.indexOf(needle)) }, extensions: [markdown({ base: markdownLanguage }), EditorState.readOnly.of(readOnly)] })
  const transactions: TransactionSpec[] = []
  const view = { get state() { return state }, dispatch(spec: TransactionSpec) { transactions.push(spec); state = state.update(spec).state } } as Pick<EditorView, 'state' | 'dispatch'>
  return { view, transactions, text: () => state.doc.toString() }
}
const basic = '| A | B |\n| :--- | ---: |\n| x | y |\n| z | w |'

describe('continuous source table commands', () => {
  it('inserts a row after the current source row in one mapped transaction', () => {
    const f = fixture(basic)
    const oldHead = f.view.state.selection.main.head
    expect(runContinuousTableCommand(f.view, 'rowAfter')).toBe(true)
    expect(f.text()).toBe(basic.replace('| x | y |', '| x | y |\n|  |  |'))
    expect(f.view.state.selection.main.head).toBe(oldHead)
    expect(f.transactions).toHaveLength(1)
  })
  it.each([
    ['rowBefore', 'x', '| A | B |\n| :--- | ---: |\n|  |  |\n| x | y |\n| z | w |'],
    ['rowBefore', 'A', '|  |  |\n| :--- | ---: |\n| A | B |\n| x | y |\n| z | w |'],
    ['rowAfter', 'A', '| A | B |\n| :--- | ---: |\n|  |  |\n| x | y |\n| z | w |'],
    ['rowUp', 'x', '| x | y |\n| :--- | ---: |\n| A | B |\n| z | w |'],
    ['rowDown', 'A', '| x | y |\n| :--- | ---: |\n| A | B |\n| z | w |'],
    ['rowDown', 'x', '| A | B |\n| :--- | ---: |\n| z | w |\n| x | y |'],
    ['deleteRow', 'A', '| x | y |\n| :--- | ---: |\n| z | w |'],
    ['deleteRow', 'x', '| A | B |\n| :--- | ---: |\n| z | w |'],
    ['deleteTable', 'x', ''],
  ])('%s maintains header/delimiter invariants at %s', (action, needle, expected) => {
    const f = fixture(basic, needle)
    expect(runContinuousTableCommand(f.view, action)).toBe(true)
    expect(f.text()).toBe(expected)
    expect(f.transactions).toHaveLength(1)
    if (action === 'rowUp' || action === 'rowDown' || action === 'rowBefore') {
      expect(f.text().slice(f.view.state.selection.main.head).startsWith(needle)).toBe(true)
    }
  })
  it('deletes the final body row without deleting the header, then removes the final header gracefully', () => {
    const f = fixture('| A |\n| --- |\n| x |')
    expect(runContinuousTableCommand(f.view, 'deleteRow')).toBe(true)
    expect(f.text()).toBe('| A |\n| --- |')
    f.view.dispatch({ selection: { anchor: 2 } })
    expect(runContinuousTableCommand(f.view, 'deleteRow')).toBe(true)
    expect(f.text()).toBe('')
  })
  it('preserves nested list/quote prefixes without duplicating list markers', () => {
    const f = fixture('> - | A | B |\n>   | --- | ---: |\n>   | x | y |\n>   | z | w |')
    expect(runContinuousTableCommand(f.view, 'rowUp')).toBe(true)
    expect(f.text()).toBe('> - | x | y |\n>   | --- | ---: |\n>   | A | B |\n>   | z | w |')
    expect(runContinuousTableCommand(f.view, 'rowBefore')).toBe(true)
    expect(f.text()).toBe('> - |  |  |\n>   | --- | ---: |\n>   | x | y |\n>   | A | B |\n>   | z | w |')
  })
  it.each([
    ['columnBefore', 'x', '|  | A | B |\n| :--- | :--- | ---: |\n|  | x | y |\n|  | z | w |'],
    ['columnAfter', 'x', '| A |  | B |\n| :--- | :--- | ---: |\n| x |  | y |\n| z |  | w |'],
    ['columnLeft', 'y', '| B | A |\n| ---: | :--- |\n| y | x |\n| w | z |'],
    ['columnRight', 'x', '| B | A |\n| ---: | :--- |\n| y | x |\n| w | z |'],
    ['deleteColumn', 'x', '| B |\n| ---: |\n| y |\n| w |'],
    ['deleteColumn', 'y', '| A |\n| :--- |\n| x |\n| z |'],
    ['alignCenter', 'y', '| A | B |\n| :--- | :---: |\n| x | y |\n| z | w |'],
    ['alignRight', 'x', '| A | B |\n| ---: | ---: |\n| x | y |\n| z | w |'],
    ['alignLeft', 'y', '| A | B |\n| :--- | :--- |\n| x | y |\n| z | w |'],
  ])('%s edits only source cells and retains column alignment', (action, needle, expected) => {
    const f = fixture(basic, needle)
    expect(runContinuousTableCommand(f.view, action)).toBe(true)
    expect(f.text()).toBe(expected)
    if (action !== 'deleteColumn') expect(f.text().slice(f.view.state.selection.main.head).startsWith(needle)).toBe(true)
    expect(f.transactions).toHaveLength(1)
  })
  it('deletes the last column gracefully', () => {
    const f = fixture('before\n\n| A |\n| --- |\n| x |\n\nafter')
    expect(runContinuousTableCommand(f.view, 'deleteColumn')).toBe(true)
    expect(f.text()).toBe('before\n\n\n\nafter')
  })
  it('obeys installed grammar: only escaped pipes, not backticks, protect cell separators', () => {
    const escaped = fixture('| A | B |\n| --- | --- |\n| a\\|b | `c\\|d` |', '`c')
    expect(runContinuousTableCommand(escaped.view, 'columnLeft')).toBe(true)
    expect(escaped.text()).toBe('| B | A |\n| --- | --- |\n| `c\\|d` | a\\|b |')
    const raw = fixture('| A | B |\n| --- | --- |\n| `c|d` | x |')
    expect(runContinuousTableCommand(raw.view, 'columnLeft')).toBe(false)
    expect(raw.transactions).toHaveLength(0)
  })
  it('preserves empty cells and source rows without outside pipes', () => {
    const f = fixture('A | B\n--- | ---:\nx |', 'x')
    expect(runContinuousTableCommand(f.view, 'columnRight')).toBe(false) // missing cell is deliberately not rewritten
    const empty = fixture('| A | B |\n| --- | --- |\n||x|')
    expect(runContinuousTableCommand(empty.view, 'columnLeft')).toBe(true)
    expect(empty.text()).toBe('| B | A |\n| --- | --- |\n|x||')
    const noOuter = fixture('A | B\n--- | ---:\nx | y')
    expect(runContinuousTableCommand(noOuter.view, 'columnRight')).toBe(true)
    expect(noOuter.text()).toBe(' B|A \n ---:|--- \n y|x ')
  })
  it('inserts a rectangular table with header included in rows and selects its first cell', () => {
    const f = fixture('')
    expect(insertContinuousTable(f.view, 3, 2)).toBe(true)
    expect(f.text()).toBe('|  |  |\n| --- | --- |\n|  |  |\n|  |  |')
    expect(f.view.state.selection.main.head).toBe(2)
    expect(f.transactions).toHaveLength(1)
  })
  it('inserts a separate block within text without dropping selected surrounding text', () => {
    const f = fixture('hello world', 'world')
    expect(insertContinuousTable(f.view, 1, 1)).toBe(true)
    expect(f.text()).toBe('hello \n\n|  |\n| --- |\n\nworld')
  })
  it('inserts into an empty nested item using continuation prefixes', () => {
    const f = fixture('> - ', '!')
    f.view.dispatch({ selection: { anchor: f.view.state.doc.length } })
    expect(insertContinuousTable(f.view, 2, 2)).toBe(true)
    expect(f.text()).toBe('> - |  |  |\n>   | --- | --- |\n>   |  |  |')
    expect(getContinuousTableContext(f.view.state)?.columns).toBe(2)
  })
  it.each([[0, 2], [2, 0], [-1, 1], [1.5, 2], [Infinity, 2], [2, NaN], [1000000, 1000000]])('rejects unsafe dimensions %s × %s', (rows, columns) => {
    const f = fixture('')
    expect(insertContinuousTable(f.view, rows, columns)).toBe(false)
    expect(f.transactions).toHaveLength(0)
  })
  it('maps delimiter and trailing-boundary carets to the correct source column', () => {
    const f = fixture(basic, '---:')
    expect(getContinuousTableContext(f.view.state)).toMatchObject({ separator: true, column: 1 })
    expect(runContinuousTableCommand(f.view, 'alignCenter')).toBe(true)
    expect(f.text()).toContain('| :--- | :---: |')
    f.view.dispatch({ selection: { anchor: f.view.state.doc.length } })
    expect(getContinuousTableContext(f.view.state)?.column).toBe(1)
  })
  it('retains a real single-column table when deleting a column without outside pipes', () => {
    const f = fixture('A | B\n--- | ---:\nx | y')
    expect(runContinuousTableCommand(f.view, 'deleteColumn')).toBe(true)
    expect(f.text()).toBe('| B|\n| ---:|\n| y|')
    expect(getContinuousTableContext(f.view.state)?.columns).toBe(1)
  })
  it.each(['rowUp', 'deleteRow'])('keeps single-cell body source valid when promoting it to header with %s', action => {
    const f = fixture('| A |\n| --- |\nx', action === 'rowUp' ? 'x' : 'A')
    expect(runContinuousTableCommand(f.view, action)).toBe(true)
    expect(f.text()).toBe(action === 'rowUp' ? '|x|\n| --- |\n| A |' : '|x|\n| --- |')
    f.view.dispatch({ selection: { anchor: 1 } })
    expect(getContinuousTableContext(f.view.state)?.columns).toBe(1)
  })
  it('separates inserted source from neighboring paragraphs so they cannot become table rows', () => {
    const f = fixture('before\nHERE\nafter', 'HERE')
    f.view.dispatch({ selection: { anchor: f.view.state.selection.main.head, head: f.view.state.selection.main.head + 4 } })
    expect(insertContinuousTable(f.view, 1, 1)).toBe(true)
    expect(f.text()).toBe('before\n\n|  |\n| --- |\n\nafter')
    expect(getContinuousTableContext(f.view.state)?.to).toBe(f.text().indexOf('\n\nafter'))
  })
  it('refuses an incomplete parsed table rather than editing only its parsed prefix', () => {
    const f = fixture(basic + '\n' + '| more | rows |\n'.repeat(50000))
    expect(syntaxTreeAvailable(f.view.state, f.view.state.doc.length)).toBe(false)
    expect(runContinuousTableCommand(f.view, 'columnAfter')).toBe(false)
    expect(f.transactions).toHaveLength(0)
  })
  it.each(['rowBefore', 'rowAfter', 'columnBefore', 'columnAfter', 'rowUp', 'rowDown', 'columnLeft', 'columnRight', 'deleteRow', 'deleteColumn', 'deleteTable', 'alignLeft', 'alignCenter', 'alignRight'])('guards readonly %s without dispatch', action => {
    const f = fixture(basic, 'x', true)
    expect(runContinuousTableCommand(f.view, action)).toBe(false)
    expect(insertContinuousTable(f.view, 2, 2)).toBe(false)
    expect(f.transactions).toHaveLength(0)
    expect(f.text()).toBe(basic)
  })
  it.each([['rowUp', 'A'], ['rowDown', 'z'], ['columnLeft', 'x'], ['columnRight', 'y'], ['notAnAction', 'x']])('leaves %s boundary/unknown actions unchanged', (action, needle) => {
    const f = fixture(basic, needle)
    expect(runContinuousTableCommand(f.view, action)).toBe(false)
    expect(f.transactions).toHaveLength(0)
  })
  it.each(['```md\n| A |\n| --- |\n| x |\n```', '<div>\n| A |\n| --- |\n| x |\n</div>', '| A | B |\n| --- | --- |\n| x |', 'plain x'])('does not reinterpret protected or malformed source', source => {
    const f = fixture(source)
    expect(runContinuousTableCommand(f.view, 'deleteColumn')).toBe(false)
    expect(f.text()).toBe(source)
    expect(f.transactions).toHaveLength(0)
  })
  it('does not insert nested tables or table syntax into fenced code', () => {
    for (const source of [basic, '```\nx\n```']) {
      const f = fixture(source)
      expect(insertContinuousTable(f.view, 2, 2)).toBe(false)
      expect(f.transactions).toHaveLength(0)
    }
  })
  it('rejects selections spanning unrelated source and ambiguous multicarets', () => {
    const f = fixture('before\n\n' + basic)
    f.view.dispatch({ selection: { anchor: 0, head: f.view.state.selection.main.head } })
    expect(runContinuousTableCommand(f.view, 'deleteTable')).toBe(false)
    expect(insertContinuousTable(f.view, 2, 2)).toBe(false)
    const multiState = EditorState.create({ doc: basic, selection: EditorSelection.create([EditorSelection.cursor(basic.indexOf('x')), EditorSelection.cursor(basic.indexOf('y'))]), extensions: [markdown({ base: markdownLanguage }), EditorState.allowMultipleSelections.of(true)] })
    const dispatch = vi.fn()
    const view = { state: multiState, dispatch } as Pick<EditorView, 'state' | 'dispatch'>
    expect(runContinuousTableCommand(view, 'deleteRow')).toBe(false)
    expect(insertContinuousTable(view, 2, 2)).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('maps a backwards UTF-16 selection with its moved source cell', () => {
    const f = fixture('| A | B |\n| --- | --- |\n| x | 😀é |', '😀')
    const from = f.view.state.selection.main.head
    f.view.dispatch({ selection: { anchor: from + '😀é'.length, head: from } })
    expect(runContinuousTableCommand(f.view, 'columnLeft')).toBe(true)
    const selection = f.view.state.selection.main
    expect(selection.anchor).toBeGreaterThan(selection.head)
    expect(f.view.state.sliceDoc(selection.from, selection.to)).toBe('😀é')
  })
  it('queries context without table-wide reads and edits only the current table', () => {
    const source = basic + '\n\n' + 'unrelated\n'.repeat(10000)
    const f = fixture(source), state = f.view.state
    // Simulate the host's completed background parser before measuring commands.
    expect(ensureSyntaxTree(state, state.doc.length, 1000)).not.toBeNull()
    const reads = vi.spyOn(state.doc, 'sliceString')
    const dispatch = vi.fn()
    const view = { state, dispatch } as Pick<EditorView, 'state' | 'dispatch'>
    try {
      expect(getContinuousTableContext(state)?.row).toBe(1)
      expect(reads.mock.calls.every(([from = 0, to = state.doc.length]) => from >= 0 && to <= basic.length)).toBe(true)
      reads.mockClear()
      expect(runContinuousTableCommand(view, 'columnRight')).toBe(true)
      expect(reads.mock.calls.every(([from = 0, to = state.doc.length]) => from >= 0 && to <= basic.length)).toBe(true)
      const transaction = state.update(dispatch.mock.calls[0][0])
      transaction.changes.iterChanges((from, to) => { expect(from).toBeGreaterThanOrEqual(0); expect(to).toBeLessThanOrEqual(basic.length) })
    } finally { reads.mockRestore() }
  })
  it('uses the host dispatch as one canonical history edit with undo and redo', () => {
    const canonical = new ChunkedDocument(basic, 8)
    canonical.select(basic.indexOf('x'))
    let state = EditorState.create({ doc: canonical.text, selection: canonical.selection, extensions: [markdown({ base: markdownLanguage })] })
    const view = { get state() { return state }, dispatch(spec: TransactionSpec) {
      const transaction = state.update(spec)
      const changes: { from: number; to: number; insert: string }[] = []
      transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => changes.push({ from, to, insert: inserted.toString() }))
      canonical.applyChanges(changes, transaction.state.selection.main)
      state = transaction.state
    } } as Pick<EditorView, 'state' | 'dispatch'>
    expect(runContinuousTableCommand(view, 'columnRight')).toBe(true)
    const edited = state.doc.toString(), selected = state.selection.main.head
    expect(canonical.content).toBe(edited)
    expect(canonical.revision).toBe(1)
    expect(canonical.selection.head).toBe(selected)
    expect(canonical.undo()).toBe(true)
    expect(canonical.content).toBe(basic)
    expect(canonical.selection.head).toBe(basic.indexOf('x'))
    expect(canonical.undo()).toBe(false)
    expect(canonical.redo()).toBe(true)
    expect(canonical.content).toBe(edited)
    expect(canonical.selection.head).toBe(selected)
  })
  it('does not insert into source whose protected-block context has not been parsed yet', () => {
    const f = fixture('paragraph\n\n'.repeat(2000) + '```\nx\n```')
    expect(syntaxTreeAvailable(f.view.state, f.view.state.selection.main.head)).toBe(false)
    expect(insertContinuousTable(f.view, 2, 2)).toBe(false)
    expect(f.transactions).toHaveLength(0)
  })
  it.each([
    ['columnBefore', 'x', '|  |A | B\n|--- |--- | ---:\n|  |x | y'],
    ['columnAfter', 'y', 'A | B|  |\n--- | ---:| ---:|\nx | y|  |'],
  ])('%s makes empty edge cells explicit on rows without outside pipes', (action, needle, expected) => {
    const f = fixture('A | B\n--- | ---:\nx | y', needle)
    expect(runContinuousTableCommand(f.view, action)).toBe(true)
    expect(f.text()).toBe(expected)
    expect(getContinuousTableContext(f.view.state)?.columns).toBe(3)
  })
  it.each([
    ['columnLeft', '|  |A | B\n --- |--- | ---:\n|  |x | y'],
    ['columnRight', 'A | B|  |\n--- | ---:| --- \nx | y|  |'],
  ])('%s preserves an empty cell moved to an implicit outer edge', (action, expected) => {
    const f = fixture('A |  | B\n--- | --- | ---:\nx |  | y', '  | y')
    expect(runContinuousTableCommand(f.view, action)).toBe(true)
    expect(f.text()).toBe(expected)
    expect(getContinuousTableContext(f.view.state)?.columns).toBe(3)
  })
  it.each([
    ['x', '|  | B\n --- | ---:\n|  | y'],
    ['y', 'A |  |\n--- | --- \nx |  |'],
  ])('keeps empty cells exposed by deleting an outer column at %s', (needle, expected) => {
    const f = fixture('A |  | B\n--- | --- | ---:\nx |  | y', needle)
    expect(runContinuousTableCommand(f.view, 'deleteColumn')).toBe(true)
    expect(f.text()).toBe(expected)
    expect(getContinuousTableContext(f.view.state)?.columns).toBe(2)
  })
  it('keeps parsed row widths invariant across edge-pipe styles and empty internal cells', () => {
    const actions = ['rowBefore', 'rowAfter', 'columnBefore', 'columnAfter', 'rowUp', 'rowDown', 'columnLeft', 'columnRight', 'deleteRow', 'deleteColumn', 'alignLeft', 'alignCenter', 'alignRight']
    for (const [leading, trailing] of [[false, false], [true, false], [false, true], [true, true]]) {
      const render = (cells: string[]) => `${leading ? '|' : ''}${cells.map(cell => ` ${cell} `).join('|')}${trailing ? '|' : ''}`
      const source = [render(['A', '', 'B']), render(['---', ':---:', '---:']), render(['x', '', 'y']), render(['z', '', 'w'])].join('\n')
      for (let column = 0; column < 3; column++) for (const action of actions) {
        const f = fixture(source)
        const context = getContinuousTableContext(f.view.state)!
        f.view.dispatch({ selection: { anchor: context.cells[column].from } })
        if (!runContinuousTableCommand(f.view, action)) continue
        f.view.dispatch({ selection: { anchor: 2 } })
        const result = getContinuousTableContext(f.view.state)
        expect(result, `${action} col=${column} pipes=${leading}/${trailing}: ${f.text()}`).not.toBeNull()
        expect(result!.columns).toBe(action === 'columnBefore' || action === 'columnAfter' ? 4 : action === 'deleteColumn' ? 2 : 3)
        // A second explicit command also validates all body row widths.
        expect(runContinuousTableCommand(f.view, 'rowAfter')).toBe(true)
      }
    }
  })
  it('resolves source caret to table row and column without dispatch', () => {
    const f = fixture(basic, 'y')
    expect(getContinuousTableContext(f.view.state)).toMatchObject({ from: 0, to: basic.length, row: 1, column: 1, columns: 2, header: false, separator: false, align: ['left', 'right'] })
    expect(f.transactions).toHaveLength(0)
    expect(getContinuousTableContext(fixture('plain text').view.state)).toBeNull()
  })
})
