import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { getContinuousTableContext, handleContinuousTableDelete } from '../continuousMarkdownTable'

function fixture(marked: string, readOnly = false, parsed = true) {
  const anchor = marked.indexOf('¦'), source = marked.replace('¦', '')
  let state = EditorState.create({ doc: source, selection: { anchor }, extensions: [
    ...(parsed ? [markdown({ base: markdownLanguage })] : []), EditorState.readOnly.of(readOnly),
  ] })
  const transactions: TransactionSpec[] = []
  const view = { get state() { return state }, dispatch(spec: TransactionSpec) {
    transactions.push(spec); state = state.update(spec).state
  } } as Pick<EditorView, 'state' | 'dispatch'>
  return { view, transactions, source, text: () => state.doc.toString(),
    marked: () => state.sliceDoc(0, state.selection.main.head) + '¦' + state.sliceDoc(state.selection.main.head) }
}

describe('protected continuous table deletion', () => {
  it.each(['| abc ¦  | z |', '|abc ¦|z|', '| xy¦  | z |'])('lets ordinary Backspace remove text and typed trailing spaces: %s', row => {
    const f = fixture('| A | B |\n| --- | --- |\n' + row)
    expect(handleContinuousTableDelete(f.view, true)).toBe(false)
    expect(f.transactions).toHaveLength(0)
  })
  it.each([
    ['| A | B |\n| --- | --- |\n| xy |¦  |', '| A | B |\n| --- | --- |\n| x¦ |  |'],
    ['| A | B |\n| --- | --- |\n| ¦xy | z |', '| A | B |\n| --- | --- |\n| x¦ | z |'],
    ['| A | B |\n| --- | --- |\n|  | ¦ |', '| A | B |\n| --- | --- |\n|  ¦|  |'],
    ['| A | B |\n| --- | --- |\n| ¦ | x |', '| A | ¦ |\n| --- | --- |\n|  | x |'],
    ['| A | B |\n| --- | --- |\n| x | y |\n| ¦ | z |', '| A | B |\n| --- | --- |\n| x | ¦ |\n|  | z |'],
    ['| A | B |\n| --- | --- |\n| é👩‍👩‍👦 | ¦ |', '| A | B |\n| --- | --- |\n| é¦ |  |'],
    ['| A | B |\n| --- | --- |\n| é | ¦ |', '| A | B |\n| --- | --- |\n| ¦ |  |'],
  ])('Backspace preserves boundaries: %s', (source, expected) => {
    const f = fixture(source)
    expect(handleContinuousTableDelete(f.view, true)).toBe(true)
    expect(f.marked()).toBe(expected)
    expect(getContinuousTableContext(f.view.state)?.columns).toBe(2)
  })
  it.each([
    ['| A | B |\n| --- | --- |\n| x¦ | yz |', '| A | B |\n| --- | --- |\n| x | ¦z |'],
    ['| A | B¦ |\n| --- | --- |\n| xy | z |', '| A | B |\n| --- | --- |\n| ¦y | z |'],
    ['| A | B |\n| --- | --- |\n| x¦ | 👩‍👩‍👦z |', '| A | B |\n| --- | --- |\n| x | ¦z |'],
    ['| A | B |\n| --- | --- |\n| x¦ |  |', '| A | B |\n| --- | --- |\n| x |  ¦|'],
  ])('forward Delete crosses only cell content: %s', (source, expected) => {
    const f = fixture(source)
    expect(handleContinuousTableDelete(f.view, false)).toBe(true)
    expect(f.marked()).toBe(expected)
    expect(getContinuousTableContext(f.view.state)?.columns).toBe(2)
  })
  it.each([
    ['|¦  | A |\n| --- | --- |\n|  |  |', true],
    ['¦|  |  |\n| --- | --- |\n|  | 后面的内容 |', true],
    ['| A | B |\n| --- | --- |\n| x | y |¦', false],
    ['| A | B |\n| ---¦ | --- |\n| x | y |', true],
    ['| A | B |\n| ---¦ | --- |\n| x | y |', false],
    ['| A | B |\n| --- | --- |\n| x | y¦ |', false],
  ] as const)('consumes first/last/delimiter boundary without writes: %s', (source, backward) => {
    const f = fixture(source)
    expect(handleContinuousTableDelete(f.view, backward)).toBe(true)
    expect(f.text()).toBe(f.source)
    expect(f.transactions).toHaveLength(0)
  })
  it('consumes a structural selection even when its head is outside the table', () => {
    const f = fixture('| A | B |\n| --- | --- |\n| x | y |\n\nafter¦')
    f.view.dispatch({ selection: { anchor: 2, head: f.view.state.doc.length } })
    expect(handleContinuousTableDelete(f.view, true)).toBe(true)
    expect(f.text()).toBe(f.source)
    expect(f.transactions).toHaveLength(1)
  })
  it('consumes a cross-cell selection rather than removing separators', () => {
    const f = fixture('| A | B |\n| --- | --- |\n| ¦x | y |')
    const anchor = f.view.state.selection.main.head
    f.view.dispatch({ selection: { anchor, head: anchor + 5 } })
    expect(handleContinuousTableDelete(f.view, false)).toBe(true)
    expect(f.text()).toBe(f.source)
    expect(f.transactions).toHaveLength(1)
  })
  it.each([true, false])('readonly consumes without dispatch (%s)', backward => {
    const f = fixture('| A | B |\n| --- | --- |\n| x¦y | z |', true)
    expect(handleContinuousTableDelete(f.view, backward)).toBe(true)
    expect(f.text()).toBe(f.source)
    expect(f.transactions).toHaveLength(0)
  })
  it.each([true, false])('ordinary text deletion and same-cell selections fall through (%s)', backward => {
    const f = fixture('| A | B |\n| --- | --- |\n| x¦yz | w |')
    expect(handleContinuousTableDelete(f.view, backward)).toBe(false)
    const anchor = f.view.state.selection.main.head
    f.view.dispatch({ selection: { anchor, head: anchor + 1 } })
    expect(handleContinuousTableDelete(f.view, backward)).toBe(false)
    expect(f.text()).toBe(f.source)
    expect(f.transactions).toHaveLength(1)
  })
  it.each([true, false])('non-table and unparsed source are untouched (%s)', backward => {
    for (const [source, parsed] of [['plain ¦text', true], ['| A | B |\n| --- | --- |\n| ¦ | z |', false]] as const) {
      const f = fixture(source, false, parsed)
      expect(handleContinuousTableDelete(f.view, backward)).toBe(false)
      expect(f.transactions).toHaveLength(0)
    }
  })
  it.each([
    ['|¦  |  |\n| --- | --- |\n|  |  |', ''],
    ['¦|||\n| --- | --- |\n|||', ''],
    ['|¦ |\n| --- |', ''],
    ['before\n\n|¦  |  |\n| --- | --- |\n|  |  |\n\nafter', 'before\n\nafter'],
    ['|¦ |\n| --- |\n\nafter', 'after'],
    ['before\n\n|¦ |\n| --- |', 'before'],
  ])('Backspace at the first empty cell removes only the empty table: %s', (source, expected) => {
    const f = fixture(source)
    const table = getContinuousTableContext(f.view.state)!
    expect(handleContinuousTableDelete(f.view, true)).toBe(true)
    expect(f.text()).toBe(expected)
    expect(f.view.state.selection.main.head).toBe(Math.min(table.from, expected.length))
    expect(f.transactions).toHaveLength(1)
  })
  it('readonly first empty cell cannot delete the table', () => {
    const f = fixture('|¦  |  |\n| --- | --- |\n|  |  |', true)
    expect(handleContinuousTableDelete(f.view, true)).toBe(true)
    expect(f.text()).toBe(f.source)
    expect(f.transactions).toHaveLength(0)
  })
  it('repeated Backspace reaches the first empty cell, then deletes the table on the next press', () => {
    const f = fixture('|  |  |\n| --- | --- |\n|  | ¦ |')
    const heads: number[] = []
    for (let i = 0; i < 3; i++) {
      expect(handleContinuousTableDelete(f.view, true)).toBe(true)
      heads.push(f.view.state.selection.main.head)
      expect(f.text()).toBe(f.source)
      expect(getContinuousTableContext(f.view.state)?.columns).toBe(2)
    }
    expect(heads).toEqual([f.source.lastIndexOf('|  |  |') + 3, 6, 3])
    expect(handleContinuousTableDelete(f.view, true)).toBe(true)
    expect(f.text()).toBe('')
  })
  it.each([
    ['| A | B |\n| --- | --- |\n| x | y |\n¦', true],
    ['before\n¦\n| A | B |\n| --- | --- |', false],
  ] as const)('protects table-adjacent newline (%s)', (source, backward) => {
    const f = fixture(source)
    expect(handleContinuousTableDelete(f.view, backward)).toBe(true)
    expect(f.text()).toBe(f.source)
    expect(f.transactions).toHaveLength(0)
  })
  it.each([
    ['| A | B |\n| --- | --- |\n| a\\¦|b | z |', true],
    ['| A | B |\n| --- | --- |\n| a¦\\|b | z |', false],
  ] as const)('cannot delete an escape and expose a new pipe (%s)', (source, backward) => {
    const f = fixture(source)
    expect(handleContinuousTableDelete(f.view, backward)).toBe(true)
    expect(f.text()).toBe(f.source)
    expect(f.transactions).toHaveLength(0)
  })
  it.each([
    ['A | B\n--- | ---\n¦x | y', true],
    ['A | B\n--- | ---\nx¦ | y', true],
    ['A | B\n--- | ---\nx | ¦y', false],
  ] as const)('does not erase an implicit edge cell (%s)', (source, backward) => {
    const f = fixture(source)
    expect(handleContinuousTableDelete(f.view, backward)).toBe(true)
    expect(f.text()).toBe(f.source)
    expect(f.transactions).toHaveLength(0)
  })
  it('handles compact zero-padding cells using real parser delimiters', () => {
    const f = fixture('|A|B|\n|-|-|\n|x|¦|')
    expect(handleContinuousTableDelete(f.view, true)).toBe(true)
    expect(f.marked()).toBe('|A|B|\n|-|-|\n|¦||')
    expect(getContinuousTableContext(f.view.state)?.columns).toBe(2)
  })
  it('retains nested quote/list prefixes while crossing the header delimiter', () => {
    const f = fixture('> - | A | B |\n>   | --- | --- |\n>   | ¦ | x |')
    expect(handleContinuousTableDelete(f.view, true)).toBe(true)
    expect(f.marked()).toBe('> - | A | ¦ |\n>   | --- | --- |\n>   |  | x |')
  })
  it.each([
    [String.raw`| a\¦\| z |`, true],
    [String.raw`| a¦\\| z |`, false],
  ] as const)('protects the parity of a backslash run before a pipe (%s)', (body, backward) => {
    const f = fixture('| A | B |\n| --- | --- |\n' + body)
    expect(handleContinuousTableDelete(f.view, backward)).toBe(true)
    expect(f.text()).toBe(f.source)
    expect(f.transactions).toHaveLength(0)
  })
  it('Backspace in an empty cell deletes the previous cell last character and moves there', () => {
    const f = fixture('| A | B |\n| --- | --- |\n| xy | ¦ |')
    expect(handleContinuousTableDelete(f.view, true)).toBe(true)
    expect(f.marked()).toBe('| A | B |\n| --- | --- |\n| x¦ |  |')
    expect(getContinuousTableContext(f.view.state)?.columns).toBe(2)
    expect(f.transactions).toHaveLength(1)
  })
})
