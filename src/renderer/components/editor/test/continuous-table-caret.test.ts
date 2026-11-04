import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, StateEffect, Transaction } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { continuousMarkdown } from '../continuousMarkdown'
import { getContinuousTableContext } from '../continuousMarkdownTable'
import { parsedMarkdownState } from './parsed-markdown-state'

const source = '正文\n\n||||\n| --- | --- | --- |\n||||\n\n末尾'
function fixture(anchor: number, rich = true, doc = source) {
  return parsedMarkdownState(EditorState.create({ doc, selection: { anchor }, extensions: [
    markdown({ base: markdownLanguage }),
    ...(rich ? [continuousMarkdown({ contextAt: () => ({ fence: '', fenceLength: 0 }),
      metadata: () => null, resolveImage: async () => null })] : []),
  ] }))
}

describe('continuous table native caret association after editing', () => {
  it('does not let a typed trailing backslash escape the existing cell delimiter', () => {
    const at = source.lastIndexOf('||||') + 2, state = fixture(at)
    const transaction = state.update({ changes: { from: at, insert: '\\' }, selection: { anchor: at + 1 }, userEvent: 'input.type' })
    expect(transaction.newDoc.toString()).toBe(source.slice(0, at) + '\\ ' + source.slice(at))
    expect(transaction.newSelection.main.head).toBe(at + 1)
    expect(transaction.annotation(Transaction.userEvent)).toBe('input.type')
    const parsed = parsedMarkdownState(transaction.state)
    expect(getContinuousTableContext(parsed)?.cells).toHaveLength(3)
    expect(getContinuousTableContext(parsed)?.column).toBe(1)
  })
  it.each(['input.type', 'input.paste', 'input.type.compose'])('protects a delimiter for %s while preserving annotations', userEvent => {
    const at = source.lastIndexOf('||||') + 1, state = fixture(at)
    const transaction = state.update({ changes: { from: at, insert: 'path\\' }, selection: { anchor: at + 5 }, userEvent,
      annotations: Transaction.addToHistory.of(false) })
    expect(transaction.newDoc.toString()).toBe(source.slice(0, at) + 'path\\ ' + source.slice(at))
    expect(transaction.newSelection.main.head).toBe(at + 5)
    expect(transaction.annotation(Transaction.userEvent)).toBe(userEvent)
    expect(transaction.annotation(Transaction.addToHistory)).toBe(false)
  })
  it.each([
    ['first header cell', '|¦|||\n| --- | --- | --- |', '\\', '|\\¦ |||\n| --- | --- | --- |'],
    ['last header cell', '|||¦|\n| --- | --- | --- |', '\\', '|||\\¦ |\n| --- | --- | --- |'],
    ['even backslash run', '|¦|\n| --- |', '\\\\', '|\\\\¦|\n| --- |'],
    ['odd backslash run', '|¦|\n| --- |', '\\\\\\', '|\\\\\\¦ |\n| --- |'],
    ['existing trailing padding', '| ¦ | c |\n| --- | --- |', '\\', '| \\¦ | c |\n| --- | --- |'],
    ['middle of content', '| a¦b | c |\n| --- | --- |', '\\', '| a\\¦b | c |\n| --- | --- |'],
    ['end of content', '| x¦| c |\n| --- | --- |', '\\', '| x\\¦ | c |\n| --- | --- |'],
    ['quoted table', '> |¦|\n> | --- |', '\\', '> |\\¦ |\n> | --- |'],
    ['ordinary pipe text', 'a¦|b', '\\', 'a\\¦|b'],
    ['literal code', '```\n|¦|\n```', '\\', '```\n|\\¦|\n```'],
  ])('only adds necessary delimiter padding: %s', (_name, marked, insert, expected) => {
    const at = marked.indexOf('¦'), state = fixture(at, true, marked.replace('¦', ''))
    const transaction = state.update({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: 'input.type' })
    expect(transaction.newDoc.toString()).toBe(expected.replace('¦', ''))
    expect(transaction.newSelection.main.head).toBe(expected.indexOf('¦'))
  })
  it('protects the delimiter when deletion exposes a trailing backslash', () => {
    const marked = '|\\¦x| b |\n| --- | --- |', at = marked.indexOf('¦'), doc = marked.replace('¦', '')
    const transaction = fixture(at, true, doc).update({ changes: { from: at, to: at + 1 }, selection: { anchor: at }, userEvent: 'delete.forward' })
    expect(transaction.newDoc.toString()).toBe('|\\ | b |\n| --- | --- |')
    expect(transaction.newSelection.main.head).toBe(at)
  })
  it('does not normalize source-only input or externally supplied Markdown', () => {
    const at = source.lastIndexOf('||||') + 1, raw = source.slice(0, at) + '\\' + source.slice(at)
    expect(fixture(at, false).update({ changes: { from: at, insert: '\\' }, userEvent: 'input.type' }).newDoc.toString()).toBe(raw)
    expect(fixture(at).update({ changes: { from: at, insert: '\\' } }).newDoc.toString()).toBe(raw)
  })
  it('maps multiple caret positions before their own added padding', () => {
    const first = source.lastIndexOf('||||') + 1, last = first + 2
    const state = fixture(first).update({ effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)) }).state
    const transaction = state.update({ changes: [{ from: first, insert: '\\' }, { from: last, insert: '\\' }],
      selection: EditorSelection.create([EditorSelection.cursor(first + 1), EditorSelection.cursor(last + 2)], 1), userEvent: 'input.type' })
    expect(transaction.newDoc.toString()).toBe(source.slice(0, first - 1) + '|\\ ||\\ |' + source.slice(last + 1))
    expect(transaction.newSelection.ranges.map(range => range.head)).toEqual([first + 1, last + 3])
    expect(transaction.newSelection.mainIndex).toBe(1)
  })
  it.each([0, 1, 2])('keeps typed text and the native caret in source column %s', column => {
    const at = source.indexOf('||||') + column + 1
    let state = fixture(at)
    for (const insert of ['a', '中', '😀']) {
      const head = state.selection.main.head
      const transaction = state.update({ changes: { from: head, insert }, selection: { anchor: head + insert.length }, userEvent: 'input.type' })
      expect(transaction.newSelection.main.head).toBe(head + insert.length)
      expect(transaction.newSelection.main.assoc).toBe(-1)
      expect(transaction.annotation(Transaction.userEvent)).toBe('input.type')
      expect(transaction.newDoc.toString()).toBe(state.sliceDoc(0, head) + insert + state.sliceDoc(head))
      state = parsedMarkdownState(transaction.state)
    }
  })
  it('restored selections at a cell end keep the caret in that cell without editing source', () => {
    const at = source.indexOf('||||') + 1
    const state = fixture(at)
    const transaction = state.update({ selection: { anchor: at } })
    expect(transaction.newSelection.main.assoc).toBe(-1)
    expect(transaction.docChanged).toBe(false)
  })
  it('does not rewrite noncollapsed drag selections', () => {
    const at = source.indexOf('||||') + 1, state = fixture(at)
    const selection = EditorSelection.create([EditorSelection.range(at, at + 2)])
    expect(state.update({ selection }).newSelection.eq(selection, true)).toBe(true)
  })
  it('does not change the native IME composition selection; normalizes the following refresh', () => {
    const at = source.indexOf('||||') + 1, state = fixture(at)
    const composing = state.update({ changes: { from: at, insert: '中' }, selection: { anchor: at + 1 }, userEvent: 'input.type.compose' })
    expect(composing.newSelection.main.assoc).toBe(0)
    const refreshed = composing.state.update({})
    expect(refreshed.newSelection.main.assoc).toBe(-1)
    expect(refreshed.docChanged).toBe(false)
  })
  it('source-only state retains ordinary selection association', () => {
    const at = source.indexOf('||||') + 1, state = fixture(at, false)
    expect(state.update({ changes: { from: at, insert: 'a' }, selection: { anchor: at + 1 } }).newSelection.main.assoc).toBe(0)
  })
  it.each(['a|b', '```\na|b\n```', '| a\\|b | c |\n| --- | --- |'])('does not bias a caret before a literal pipe: %s', doc => {
    const at = doc.indexOf('a') + doc.slice(doc.indexOf('a')).indexOf('|')
    const state = fixture(at, true, doc)
    expect(state.update({ selection: { anchor: at } }).newSelection.main.assoc).toBe(0)
  })
})
