import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { getInlineMarkdownSpans } from '@/shared/utils/tiptap-inline-markdown'
import { continuousMarkdownSyntax } from '../continuousMarkdownSyntax'
import { runContinuousMarkdownCommand, adjustContinuousHeading } from '../continuousMarkdownCommands'

function editor(source: string, anchor = 0, head = anchor, readOnly = false) {
  let state = EditorState.create({ doc: source, selection: { anchor, head }, extensions: [
    markdown({ base: markdownLanguage, extensions: [continuousMarkdownSyntax] }), EditorState.readOnly.of(readOnly),
  ] })
  const transactions: TransactionSpec[] = []
  const view: Pick<EditorView, 'state' | 'dispatch'> = {
    get state() { return state },
    dispatch: ((spec: TransactionSpec) => {
      transactions.push(spec)
      state = state.update(spec).state
    }) as EditorView['dispatch'],
  }
  return { view, transactions, text: () => state.doc.toString(), selection: () => state.selection.main,
    select: (anchor: number, head = anchor) => { state = state.update({ selection: EditorSelection.single(anchor, head) }).state } }
}

describe('continuous Markdown commands', () => {
  it.each([['bold', '**'], ['italic', '*'], ['strike', '~~'], ['inlineCode', '`'], ['highlight', '==']])('inserts and removes empty %s markers in a single dispatch', (action, marker) => {
    const e = editor('before after', 7)
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    expect(e.text()).toBe(`before ${marker}${marker}after`)
    expect(e.selection().anchor).toBe(7 + marker.length)
    expect(e.transactions).toHaveLength(1)
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    expect(e.text()).toBe('before after')
    expect(e.selection().anchor).toBe(7)
  })

  it.each(['bold', 'italic', 'strike', 'inlineCode', 'highlight'])('roundtrips %s over multiline nested source and a backward selection', action => {
    const source = '> alpha *nested*\n> beta `code`\n\n- gamma'
    const e = editor(source, source.length, 2)
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    expect(e.selection().anchor).toBeGreaterThan(e.selection().head)
    expect(e.text()).toContain('\n> ')
    expect(e.text()).toContain('\n\n- ')
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    expect(e.text()).toBe(source)
    expect(e.selection().anchor).toBe(source.length)
    expect(e.selection().head).toBe(2)
    expect(e.transactions).toHaveLength(2)
  })

  it.each([
    ['bold', '**outer *inner* text**', 'inner', 'outer *inner* text'],
    ['italic', '**outer *inner* text**', 'inner', '**outer inner text**'],
    ['bold', '__bold__', 'bold', 'bold'],
    ['strike', '~~gone~~', 'one', 'gone'],
    ['highlight', '==outer **bold**==', 'bold', 'outer **bold**'],
    ['bold', '**first\nsecond**', 'second', 'first\nsecond'],
  ])('removes the innermost enclosing %s format without damaging nested source', (action, source, selected, expected) => {
    const at = source.indexOf(selected)
    const e = editor(source, at, at + selected.length)
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    expect(e.text()).toBe(expected)
    expect(e.view.state.sliceDoc(e.selection().from, e.selection().to)).toBe(selected)
  })

  it.each(['a`b', '`edge', 'edge`', ' left', 'right ', ' both ', '   ', '``', 'a``b`c', '\ttext\t'])('roundtrips inline code with backticks/whitespace: %j', source => {
    const e = editor(`prefix ${source} suffix`, 7, 7 + source.length)
    expect(runContinuousMarkdownCommand(e.view, 'inlineCode')).toBe(true)
    expect(runContinuousMarkdownCommand(e.view, 'inlineCode')).toBe(true)
    expect(e.text()).toBe(`prefix ${source} suffix`)
    expect(e.selection().from).toBe(7)
    expect(e.selection().to).toBe(7 + source.length)
  })

  it('preserves boundary whitespace outside emphasis delimiters', () => {
    const e = editor('  words  ', 0, 9)
    runContinuousMarkdownCommand(e.view, 'bold')
    expect(e.text()).toBe('  **words**  ')
    runContinuousMarkdownCommand(e.view, 'bold')
    expect(e.text()).toBe('  words  ')
  })

  it('moves symmetrically through paragraph, H6 … H1 and maps the content selection', () => {
    const e = editor('title', 1, 4)
    expect(adjustContinuousHeading(e.view, 'down')).toBe(false)
    for (let level = 6; level >= 1; level--) {
      expect(adjustContinuousHeading(e.view, 'up')).toBe(true)
      expect(e.text()).toBe(`${'#'.repeat(level)} title`)
      expect(e.view.state.sliceDoc(e.selection().from, e.selection().to)).toBe('itl')
    }
    expect(adjustContinuousHeading(e.view, 'up')).toBe(false)
    for (let level = 2; level <= 7; level++) {
      expect(adjustContinuousHeading(e.view, 'down')).toBe(true)
      expect(e.text()).toBe(level === 7 ? 'title' : `${'#'.repeat(level)} title`)
    }
    expect(e.selection().from).toBe(1)
    expect(e.selection().to).toBe(4)
    expect(e.transactions).toHaveLength(12)
  })

  it.each([1, 2, 3, 4, 5, 6])('toggles H%s while preserving list/quote ancestry', level => {
    const source = '> - title'
    const e = editor(source, 6, 9)
    expect(runContinuousMarkdownCommand(e.view, `h${level}`)).toBe(true)
    expect(e.text()).toBe(`> - ${'#'.repeat(level)} title`)
    expect(runContinuousMarkdownCommand(e.view, `h${level}`)).toBe(true)
    expect(e.text()).toBe(source)
    expect(e.selection().anchor).toBe(6)
    expect(e.selection().head).toBe(9)
  })

  it.each([
    ['title\n=====', 'h3', '### title'],
    ['> title\n> -----', 'h1', '> # title'],
    ['title\n-----\n\nafter', 'paragraph', 'title\n\nafter'],
    ['## title ##', 'h3', '### title'],
  ])('converts heading source %j without leaving Setext or closing markers', (source, action, expected) => {
    const at = source.indexOf('title') + 1
    const e = editor(source, at, at + 2)
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    expect(e.text()).toBe(expected)
    expect(e.view.state.sliceDoc(e.selection().from, e.selection().to)).toBe('it')
  })

  it('adjusts all selected headings without touching the line at an exclusive end', () => {
    const e = editor('one\n## two\nthree', 0, 10)
    expect(adjustContinuousHeading(e.view, 'up')).toBe(true)
    expect(e.text()).toBe('###### one\n# two\nthree')
    expect(e.transactions).toHaveLength(1)
  })

  it('refuses headings in literal blocks or read-only documents', () => {
    for (const source of ['```\ntitle\n```', '    title', '<div>\ntitle\n</div>']) {
      const e = editor(source, source.indexOf('title'))
      expect(adjustContinuousHeading(e.view, 'up')).toBe(false)
      expect(runContinuousMarkdownCommand(e.view, 'h1')).toBe(false)
      expect(e.transactions).toHaveLength(0)
    }
    expect(adjustContinuousHeading(editor('title', 0, 0, true).view, 'up')).toBe(false)
  })

  it.each([['bulletList', '- '], ['orderedList', '1. '], ['taskList', '- [ ] '], ['blockquote', '> ']])('toggles %s across selected lines with one transaction', (action, prefix) => {
    const source = 'alpha\nbeta'
    const e = editor(source, source.length, 0)
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    expect(e.text()).toBe(`${prefix}alpha\n${action === 'orderedList' ? '2. ' : prefix}beta`)
    expect(e.transactions).toHaveLength(1)
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    expect(e.text()).toBe(source)
    expect(e.selection().anchor).toBe(source.length)
    expect(e.selection().head).toBe(0)
  })

  it.each([
    ['> - outer\n>   - inner', 'inner', 'orderedList', '> - outer\n>   1. inner'],
    ['> 1. task', 'task', 'taskList', '> - [ ] task'],
    ['> - [x] task', 'task', 'orderedList', '> 1. task'],
    ['> - [x] task', 'task', 'taskList', '> task'],
    ['> > nested', 'nested', 'blockquote', '> nested'],
    ['- item', 'item', 'blockquote', '- > item'],
    ['> quote', 'quote', 'bulletList', '> - quote'],
  ])('preserves structural ancestry when changing %j to %s', (source, selected, action, expected) => {
    const at = source.indexOf(selected)
    const e = editor(source, at, at + selected.length)
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    expect(e.text()).toBe(expected)
    expect(e.view.state.sliceDoc(e.selection().from, e.selection().to)).toBe(selected)
  })

  it('reindents list descendants when the parent marker width changes', () => {
    const e = editor('> - parent\n>   - child\n>     continuation', 4, 10)
    expect(runContinuousMarkdownCommand(e.view, 'orderedList')).toBe(true)
    expect(e.text()).toBe('> 1. parent\n>    - child\n>      continuation')
    expect(e.view.state.sliceDoc(e.selection().from, e.selection().to)).toBe('parent')
  })

  it.each(['bulletList', 'orderedList', 'taskList', 'blockquote'])('inserts %s in an empty paragraph with a typing caret', action => {
    const e = editor('')
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    expect(e.selection().head).toBe(e.text().length)
    expect(e.text().length).toBeGreaterThan(0)
  })

  it('refuses non-code block commands inside literal blocks', () => {
    for (const action of ['bulletList', 'orderedList', 'taskList', 'blockquote', 'horizontalRule']) {
      const e = editor('```\nliteral\n```', 6)
      expect(runContinuousMarkdownCommand(e.view, action)).toBe(false)
      expect(e.transactions).toHaveLength(0)
    }
  })

  it.each([
    ['alpha\nbeta', '```\nalpha\nbeta\n```'],
    ['> alpha\n> beta', '> ```\n> alpha\n> beta\n> ```'],
    ['- alpha\n  beta', '- ```\n  alpha\n  beta\n  ```'],
    ['> - alpha\n>   beta', '> - ```\n>   alpha\n>   beta\n>   ```'],
    ['text with ``` inside', '````\ntext with ``` inside\n````'],
  ])('toggles fences around %j preserving containers and selection', (source, expected) => {
    const at = source.indexOf('alpha') >= 0 ? source.indexOf('alpha') : 0
    const e = editor(source, at, source.length)
    expect(runContinuousMarkdownCommand(e.view, 'codeBlock')).toBe(true)
    expect(e.text()).toBe(expected)
    expect(e.transactions).toHaveLength(1)
    expect(runContinuousMarkdownCommand(e.view, 'codeBlock')).toBe(true)
    expect(e.text()).toBe(source)
    expect(e.selection().from).toBe(at)
    expect(e.selection().to).toBe(source.length)
  })

  it.each([
    ['~~~js meta\nconst x = 1\n~~~', 'const x = 1'],
    ['```\nline\n', 'line\n'],
    ['    one\n    two', 'one\ntwo'],
    ['> ```js\n> one\n> two\n> ```', '> one\n> two'],
  ])('unwraps existing literal code %j without losing its content', (source, expected) => {
    const at = source.includes('one') ? source.indexOf('one') : source.includes('const') ? source.indexOf('const') : source.indexOf('line')
    const e = editor(source, at + 1)
    expect(runContinuousMarkdownCommand(e.view, 'codeBlock')).toBe(true)
    expect(e.text()).toBe(expected)
    expect(e.text()[e.selection().head]).toBe(source[at + 1])
  })

  it('creates an empty code block with a caret on the content line', () => {
    const e = editor('')
    expect(runContinuousMarkdownCommand(e.view, 'codeBlock')).toBe(true)
    expect(e.text()).toBe('```\n\n```')
    expect(e.selection().head).toBe(4)
    expect(runContinuousMarkdownCommand(e.view, 'codeBlock')).toBe(true)
    expect(e.text()).toBe('')
    expect(e.selection().head).toBe(0)
  })

  it('inserts a horizontal rule without deleting selected content or quote ancestry', () => {
    const e = editor('> alpha', 3, 6)
    expect(runContinuousMarkdownCommand(e.view, 'horizontalRule')).toBe(true)
    expect(e.text()).toBe('> alpha\n> \n> ---\n> ')
    expect(e.view.state.sliceDoc(e.selection().from, e.selection().to)).toBe('lph')
    expect(e.transactions).toHaveLength(1)
  })

  it('converts Setext within a list without moving the list marker into the title', () => {
    const e = editor('> - title\n>   =====', 5, 8)
    expect(runContinuousMarkdownCommand(e.view, 'h3')).toBe(true)
    expect(e.text()).toBe('> - ### title')
    expect(e.view.state.sliceDoc(e.selection().from, e.selection().to)).toBe('itl')
  })

  it.each(['bold', 'italic'])('adds a real enclosing %s span around nested source', action => {
    const source = action === 'bold' ? '**inner** tail' : '*inner* tail'
    const e = editor(source, 0, source.length)
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    const span = getInlineMarkdownSpans(e.text()).find(span => span.type === action && span.from === 0 && span.to === e.text().length)
    expect(span).toBeDefined()
    expect(e.text().slice(span!.contentFrom, span!.contentTo)).toBe(source)
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    expect(e.text()).toBe(source)
  })

  it.each(['bold', 'italic', 'strike', 'inlineCode', 'highlight'])('formats a local %s selection on a long line without flattening the document', action => {
    const source = 'text '.repeat(20000)
    const e = editor(source, 45000, 45004)
    // A real EditorView completes Markdown parsing in the background. Prime it
    // explicitly here rather than depending on a CPU-sensitive 100ms deadline.
    expect(ensureSyntaxTree(e.view.state, e.view.state.doc.length, 3000)).not.toBeNull()
    const flatten = vi.spyOn(e.view.state.doc, 'toString').mockImplementation(() => { throw new Error('whole-document stringify') })
    try {
      expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
      expect(flatten).not.toHaveBeenCalled()
      expect(ensureSyntaxTree(e.view.state, e.view.state.doc.length, 3000)).not.toBeNull()
      expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
      expect(e.text()).toBe(source)
      expect(e.selection().from).toBe(45000)
      expect(e.selection().to).toBe(45004)
    } finally { flatten.mockRestore() }
  })

  it('keeps reads bounded even when formatting an entire long selected line', () => {
    const source = 'words '.repeat(20000)
    const e = editor(source, 0, source.length)
    expect(ensureSyntaxTree(e.view.state, source.length, 3000)).not.toBeNull()
    const reads = vi.spyOn(e.view.state.doc, 'sliceString')
    try {
      expect(runContinuousMarkdownCommand(e.view, 'inlineCode')).toBe(true)
      expect(Math.max(...reads.mock.calls.map(([from, to]) => (to ?? source.length) - from))).toBeLessThanOrEqual(32768)
    } finally { reads.mockRestore() }
  })

  it('toggles code on sibling list items without swallowing their structural markers', () => {
    const source = '> - first\n> - second'
    const e = editor(source, 4, source.length)
    expect(runContinuousMarkdownCommand(e.view, 'codeBlock')).toBe(true)
    expect(e.text()).toBe('> - ```\n>   first\n>   ```\n> - ```\n>   second\n>   ```')
    expect(e.transactions).toHaveLength(1)
    expect(runContinuousMarkdownCommand(e.view, 'codeBlock')).toBe(true)
    expect(e.text()).toBe(source)
    expect(e.transactions).toHaveLength(2)
  })

  it('removes a long enclosing multiline highlight using the installed syntax tree', () => {
    const source = '==start ' + 'long words '.repeat(4000) + '\nsecond line=='
    const at = source.indexOf('second')
    const e = editor(source, at, at + 6)
    expect(ensureSyntaxTree(e.view.state, source.length, 3000)).not.toBeNull()
    expect(runContinuousMarkdownCommand(e.view, 'highlight')).toBe(true)
    expect(e.text()).toBe(source.slice(2, -2))
    expect(e.view.state.sliceDoc(e.selection().from, e.selection().to)).toBe('second')
  })

  it.each([
    ['***triple***', 'bold', '*triple*'],
    ['***triple***', 'italic', '**triple**'],
    ['___triple___', 'bold', '_triple_'],
    ['___triple___', 'italic', '__triple__'],
  ])('preserves native nested triple emphasis in %j when toggling %s', (source, action, expected) => {
    const at = source.indexOf('triple')
    const e = editor(source, at, at + 6)
    expect(runContinuousMarkdownCommand(e.view, action)).toBe(true)
    expect(e.text()).toBe(expected)
    expect(e.view.state.sliceDoc(e.selection().from, e.selection().to)).toBe('triple')
  })

  it('does not format literal code, HTML or read-only source', () => {
    for (const source of ['```\ntext\n```', '    text', '<div>\ntext\n</div>']) {
      const e = editor(source, source.indexOf('text') + 1)
      expect(runContinuousMarkdownCommand(e.view, 'bold')).toBe(false)
      expect(e.transactions).toHaveLength(0)
    }
    const e = editor('text', 1, 1, true)
    expect(runContinuousMarkdownCommand(e.view, 'bold')).toBe(false)
    expect(runContinuousMarkdownCommand(e.view, 'unknown')).toBe(false)
    expect(e.transactions).toHaveLength(0)
  })
})
