import { describe, expect, it, vi } from 'vitest'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { buildContinuousCodeDecorations, buildContinuousCodePlan, changeContinuousCodeLanguage, continuousMarkdownCode, readContinuousCodeContent } from '../continuousMarkdownCode'
import { history, undo } from '@codemirror/commands'
import type { TransactionSpec } from '@codemirror/state'
import { parsedMarkdownState } from './parsed-markdown-state'

const mutableView = (doc: string, readOnly = false) => {
  const view = {
    state: parsedMarkdownState(EditorState.create({ doc, extensions: [markdown(), history(), EditorState.readOnly.of(readOnly)] })),
    dispatch(spec: TransactionSpec) { view.state = parsedMarkdownState(view.state.update(spec).state) },
  }
  return view
}

const state = (doc: string) => parsedMarkdownState(EditorState.create({ doc, extensions: [markdown()] }))

describe('continuous Markdown code', () => {
  it('changes only the language token using the same dispatcher and shared undo history', () => {
    const source = 'before\n\n~~~ js title="keep"\nconst a = 1\n~~~\nafter'
    const view = mutableView(source)
    const position = source.indexOf('~~~')
    expect(changeContinuousCodeLanguage(view, position, 'python')).toBe(true)
    expect(view.state.doc.toString()).toBe(source.replace('js title', 'python title'))
    expect(undo({ state: view.state, dispatch: transaction => { view.state = parsedMarkdownState(transaction.state) } })).toBe(true)
    expect(view.state.doc.toString()).toBe(source)
    expect(changeContinuousCodeLanguage(mutableView(source, true), position, 'python')).toBe(false)
    expect(changeContinuousCodeLanguage(view, position, '<script>')).toBe(false)
    expect(changeContinuousCodeLanguage(view, 0, 'python')).toBe(false)
  })

  it('replaces a pathological info token completely without touching its metadata or body', () => {
    const token = 'x'.repeat(1000)
    const source = `\`\`\`${token} title\nbody\n\`\`\``
    const view = mutableView(source)
    expect(changeContinuousCodeLanguage(view, 0, 'js')).toBe(true)
    expect(view.state.doc.toString()).toBe('```js title\nbody\n```')
  })

  it('copies only literal content, preserving spaces, blank lines and the final body newline', () => {
    for (const [source, expected] of [
      ['```js\n  a\n\n<script> & **x**\n```', '  a\n\n<script> & **x**\n'],
      ['```\n```', ''], ['~~~\na\n', 'a\n'], ['> ```js\n> a\n> ```', 'a\n'],
      ['> ```js\n> a\n> b\n> ```', 'a\nb\n'],
      ['> ```js\n> a\n>\n> b\n> ```', 'a\n\nb\n'],
      ['- ```js\n  a\n    b\n  ```', 'a\n  b\n'],
    ]) {
      const s = state(source)
      expect(readContinuousCodeContent(s, source.indexOf(source.includes('~~~') ? '~~~' : '```'))).toBe(expected)
      expect(s.doc.toString()).toBe(source)
    }
  })

  it('decorates only fence syntax with an inline toolbar and leaves native code text in place', () => {
    const source = '```js\nconst a = 1\n```'
    const s = parsedMarkdownState(EditorState.create({ doc: source, extensions: [markdown(), continuousMarkdownCode()] }))
    const decorations = buildContinuousCodeDecorations(s, [{ from: 0, to: s.doc.length }])
    const replacements: { from: number; to: number; widget: boolean }[] = []
    decorations.between(0, s.doc.length, (from, to, decoration) => {
      if (!decoration.spec.class && from < to) replacements.push({ from, to, widget: !!decoration.spec.widget })
    })
    expect(replacements).toEqual([{ from: 0, to: 5, widget: true }, { from: 18, to: 21, widget: false }])
    expect(s.doc.toString()).toBe(source)
  })

  it('auto-highlights indented and unlabelled code but leaves explicit text/unknown languages literal', () => {
    for (const source of ['    const value = true;\n', '```\nconst value = true;\n```']) {
      const s = state(source)
      expect(buildContinuousCodePlan(s, [{ from: 0, to: s.doc.length }]).marks.length).toBeGreaterThan(0)
    }
    for (const language of ['text', 'not-a-registered-language']) {
      const s = state(`\`\`\`${language}\nconst value = true;\n\`\`\``)
      expect(buildContinuousCodePlan(s, [{ from: 0, to: s.doc.length }]).marks).toEqual([])
    }
  })

  it('bounds highlighting reads inside a two-million-character code line at a distant viewport', () => {
    const s = state('```js\n' + 'x'.repeat(2_000_000) + '\n```')
    expect(ensureSyntaxTree(s, s.doc.length, 1000)).not.toBeNull() // Test setup only; production never forces parsing.
    const read = vi.spyOn(s, 'sliceDoc')
    const viewport = { from: 1_000_000, to: 1_004_500 }
    const plan = buildContinuousCodePlan(s, [viewport])
    expect(plan.blocks).toHaveLength(1)
    expect(plan.scanned).toBe(4500)
    expect(read.mock.calls.every(([from = 0, to = s.doc.length]) => to - from <= 4096)).toBe(true)
    expect(plan.marks.every(mark => mark.from >= viewport.from && mark.to <= viewport.to)).toBe(true)
    read.mockRestore()
  })

  it('caps total highlighting input and produces no offscreen toolbar when inside code', () => {
    const s = state('```js\n' + 'const a = 1;\n'.repeat(6000) + '```')
    expect(ensureSyntaxTree(s, s.doc.length, 1000)).not.toBeNull()
    const plan = buildContinuousCodePlan(s, [{ from: 100, to: 70_000 }])
    expect(plan.scanned).toBeLessThanOrEqual(32768)
    const decorations = buildContinuousCodeDecorations(s, [{ from: 100, to: 200 }])
    let widgets = 0
    decorations.between(0, s.doc.length, (from, to, decoration) => { if (decoration.spec.widget && from < to) widgets++ })
    expect(widgets).toBe(0)
  })

  it('inserts a missing CodeInfo at the existing fence and preserves selection through normal transactions', () => {
    const view = mutableView('~~~   \nlet x = 1\n~~~')
    view.state = view.state.update({ selection: { anchor: 10 } }).state
    expect(changeContinuousCodeLanguage(view, 0, 'typescript')).toBe(true)
    expect(view.state.doc.toString()).toBe('~~~typescript   \nlet x = 1\n~~~')
    expect(view.state.selection.main.head).toBe(20)
    expect(changeContinuousCodeLanguage(view, 0, 'typescript')).toBe(false)
  })

  it('keeps long info lines bounded and literal source independent of display selection', () => {
    const source = '```' + 'x'.repeat(20_000) + '\nconst a=1\n```'
    const s = state(source)
    const read = vi.spyOn(s, 'sliceDoc')
    const decorations = buildContinuousCodeDecorations(s, [{ from: 0, to: 200 }])
    const widgets: [number, number][] = []
    decorations.between(0, s.doc.length, (from, to, decoration) => { if (decoration.spec.widget) widgets.push([from, to]) })
    expect(widgets).toEqual([[0, 3]])
    expect(read.mock.calls.every(([from = 0, to = s.doc.length]) => to - from <= 256)).toBe(true)
    read.mockRestore()
    const before = buildContinuousCodePlan(s, [{ from: 0, to: 200 }])
    const after = buildContinuousCodePlan(s.update({ selection: { anchor: 100 } }).state, [{ from: 0, to: 200 }])
    expect(after).toEqual(before)
    expect(s.doc.toString()).toBe(source)
  })

  it('uses installed Markdown AST positions and highlights literal code only', () => {
    const source = '**outside**\n\n```js title\nconst value = "**literal** <tag>"\n```\n'
    const s = state(source)
    const plan = buildContinuousCodePlan(s, [{ from: 0, to: s.doc.length }])
    expect(plan.blocks).toHaveLength(1)
    const block = plan.blocks[0]
    expect(s.sliceDoc(block.info!.from, block.info!.to)).toBe('js title')
    expect(block.language).toBe('js')
    expect(plan.marks.some(mark => s.sliceDoc(mark.from, mark.to) === 'const' && mark.className.includes('hljs-keyword'))).toBe(true)
    expect(plan.marks.every(mark => mark.from >= block.content.from && mark.to <= block.content.to)).toBe(true)
    expect(s.doc.toString()).toBe(source)
  })
})
