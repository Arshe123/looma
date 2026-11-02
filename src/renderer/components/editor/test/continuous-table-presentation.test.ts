import { Text } from '@codemirror/state'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { expect, it } from 'vitest'
import { buildContinuousMarkdownPlan } from '../continuousMarkdown'

it('hides table padding syntax without hiding editable content or rewriting source', () => {
  const source = '| 名称 | 数值 |\n| --- | --- |\n| **粗体** |  2  |\n|   | 空 |'
  const doc = Text.of(source.split('\n'))
  const plan = buildContinuousMarkdownPlan(doc, [{ from: 0, to: doc.length }], {
    contextAt: () => ({ fence: '', fenceLength: 0 }), metadata: () => null,
    tree: markdownLanguage.parser.parse(source),
  })
  const at = source.indexOf('  2  ')
  expect(plan.marks).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: at, to: at + 2, className: 'looma-continuous-table-syntax' }),
    expect.objectContaining({ from: at + 3, to: at + 5, className: 'looma-continuous-table-syntax' }),
  ]))
  expect(plan.replacements.some(range => range.from >= at && range.from < at + 5)).toBe(false)
  expect(plan.lines.find(line => line.line === 2)?.className).toContain('looma-continuous-table-separator')
  expect(doc.toString()).toBe(source)
})

it('keeps zero-length cells source-backed without replacement widgets or gaps between wrappers', () => {
  const source = '|||\n| --- | --- |\n|||'
  const doc = Text.of(source.split('\n'))
  const plan = buildContinuousMarkdownPlan(doc, [{ from: 0, to: doc.length }], {
    contextAt: () => ({ fence: '', fenceLength: 0 }), metadata: () => null,
    tree: markdownLanguage.parser.parse(source),
  })
  const cells = plan.marks.filter(mark => mark.className === 'looma-continuous-table-cell')
  expect(cells.map(cell => source.slice(cell.from, cell.to))).toEqual(['|', '||', '|', '||'])
  expect(plan.replacements.every(range => range.from >= doc.line(2).from && range.to <= doc.line(2).to)).toBe(true)
  expect(plan.marks.filter(mark => mark.className === 'looma-continuous-table-syntax')).toHaveLength(6)
})
