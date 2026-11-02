import { describe, expect, it, vi } from 'vitest'
import { buildMarkdownReferenceIndex } from '@/shared/utils/markdown-reference-index'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { getContinuousReferenceTrigger, getContinuousReferenceAtPosition, getContinuousReferenceRuns } from '../continuousMarkdownReferences'
import { getContinuousInlineSpans } from '../continuousMarkdownSyntax'
import { syntaxTree } from '@codemirror/language'

const referenceSpans = (state: EditorState) => getContinuousInlineSpans(state.doc, syntaxTree(state), 0, state.doc.length)

describe('portable reference source and presentation', () => {
  it('copies the entire nested label, title and anchor, not a clicked formatting run', () => {
    const source = '前 [**完整** *引用*](<../目标 笔记.md#L12-15> "说明") 后'
    const state = stateAtEnd(source)
    expect(getContinuousReferenceAtPosition(state, source.indexOf('引用'))).toMatchObject({
      source: '[**完整** *引用*](<../目标%20笔记.md#L12-15> "说明")',
      label: '**完整** *引用*', href: '../目标 笔记.md#L12-15', title: '说明',
    })
  })
  it('makes reference-definition links portable with a full label and escaped title', () => {
    const source='[**引用**][ref]\n\n[ref]: <target.md#L12-15> "a &quot;title&quot;"'
    const state=stateAtEnd(source)
    expect(getContinuousReferenceAtPosition(state,4,buildMarkdownReferenceIndex(source))?.source)
      .toBe('[**引用**](target.md#L12-15 "a \\"title\\"")')
  })
  it('reads only the clicked link, not the giant surrounding paragraph', () => {
    const prefix='前文 '.repeat(10000), source=prefix+'[引用](target.md "title")'+' 后文'.repeat(10000)
    const state=stateAtEnd(source),read=vi.spyOn(state.doc,'sliceString')
    try {
      expect(getContinuousReferenceAtPosition(state,prefix.length+2)?.source).toBe('[引用](target.md "title")')
      expect(Math.max(...read.mock.calls.map(([from,to])=>(to??state.doc.length)-(from??0)))).toBeLessThan(100)
    } finally { read.mockRestore() }
  })
  it('decorates only visible label runs with one icon and complete attributes on every run', () => {
    const state = stateAtEnd('[**完整** *引用*](target.md#标题 "说明") [相邻](target.md)')
    const runs = getContinuousReferenceRuns(referenceSpans(state))
    expect(runs.map(run => state.doc.sliceString(run.from, run.to))).toEqual(['完整', ' ', '引用', '相邻'])
    expect(runs.map(run => !!run.attributes['data-inline-markdown-link-continuation'])).toEqual([false, true, true, false])
    expect(runs[0].attributes).toMatchObject({ href: 'target.md#标题', title: '说明', 'data-looma-note-ref': 'target.md#标题', class: 'looma-note-ref' })
  })
  it('marks a clipped first run as continuation so line/viewport splits never duplicate icons', () => {
    const state = stateAtEnd('[完整引用](target.md)')
    const runs = getContinuousReferenceRuns(referenceSpans(state), { from: 3, to: 5 })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({from:3,to:5,attributes:{'data-inline-markdown-link-continuation':'true'}})
  })
  it('classifies external links and refuses obfuscated executable destinations', () => {
    expect(getContinuousReferenceRuns([{type:'link',from:0,to:4,contentFrom:1,contentTo:2,href:'java\nscript:alert(1)'}])).toEqual([])
    const state = stateAtEnd('[网站](https://example.com?q=1 "site")')
    expect(getContinuousReferenceRuns(referenceSpans(state))[0].attributes).toMatchObject({class:'looma-external-link',title:'site'})
    expect(getContinuousReferenceAtPosition(state, 2)).toBeNull()
  })
})

const stateAtEnd = (doc: string) => {
  const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [markdown()] })
  ensureSyntaxTree(state, doc.length, 500)
  return state.update({}).state
}

describe('continuous note reference input', () => {
  it('finds only the two typed brackets without reading the whole paragraph', () => {
    const state = stateAtEnd('前文 '.repeat(5000) + '[[')
    expect(getContinuousReferenceTrigger(state)).toEqual({ from: state.doc.length - 2, to: state.doc.length })
  })
  it.each(['`[[`', '```md\n[[', '    [[', '<!-- [['])('ignores literal syntax: %s', doc => {
    const state = stateAtEnd(doc)
    const at = doc.indexOf('[[') + 2
    expect(getContinuousReferenceTrigger(state.update({ selection: { anchor: at } }).state)).toBeNull()
  })
  it('does not trigger read-only or nonempty selections', () => {
    const state = stateAtEnd('[[')
    expect(getContinuousReferenceTrigger(EditorState.create({ doc: '[[', selection: { anchor: 2 }, extensions: [EditorState.readOnly.of(true)] }))).toBeNull()
    expect(getContinuousReferenceTrigger(state.update({ selection: { anchor: 0, head: 2 } }).state)).toBeNull()
  })
})
