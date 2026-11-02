import { Text } from '@codemirror/state'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { getContinuousBlockLine } from '../continuousMarkdownBlocks'

const fixture = (source: string) => {
  const doc = Text.of(source.split('\n'))
  const tree = markdownLanguage.parser.parse(source)
  return (line: number) => getContinuousBlockLine(doc, tree, doc.line(line))
}

describe('continuous Markdown block structure', () => {
  it('recognizes both Setext levels and distinguishes a horizontal rule', () => {
    const line = fixture('标题\n======\n\n二级\n------\n\n---')
    expect(line(1)).toMatchObject({ heading: { level: 1, from: 0, titleAt: 2 } })
    expect(line(2)).toMatchObject({ heading: { level: 1 }, setextMarker: true })
    expect(line(4)).toMatchObject({ heading: { level: 2 } })
    expect(line(5).setextMarker).toBe(true)
    expect(line(7).rule).toBe(true)
  })

  it('uses parsed ancestors for nested/continuation list and quote lines', () => {
    const line = fixture('> - 父项\n>   - 子项\n>     续行\n>\n> > 嵌套引用')
    expect(line(1)).toMatchObject({ listDepth: 1, quoteDepth: 1 })
    expect(line(2)).toMatchObject({ listDepth: 2, quoteDepth: 1 })
    expect(line(3)).toMatchObject({ listDepth: 2, quoteDepth: 1 })
    expect(line(5)).toMatchObject({ quoteDepth: 2 })
  })

  it('identifies task marker source ranges without changing list text', () => {
    const line = fixture('- [ ] 未完成\n- [X] 已完成\n\n```md\n- [x] 字面内容\n```')
    expect(line(1).task).toEqual({ from: 2, to: 5, checked: false })
    expect(line(2).task).toEqual({ from: 12, to: 15, checked: true })
    expect(line(5).task).toBeUndefined()
    expect(line(5).literal).toBe(true)
  })

  it('keeps quoted code literal while hiding only the structural quote prefix', () => {
    const source = '> ```js\n> **not bold**\n> ```'
    const line = fixture(source)(2)
    expect(line).toMatchObject({ literal: true, quoteDepth: 1 })
    const from = source.indexOf('> **')
    expect(line.markers).toEqual([{ from, to: from + 2 }])
    expect(line.task).toBeUndefined()
  })

  it('builds equal-column table rows with original cell source and alignment', () => {
    const source = '| 名称 | 数值 |\n| :--- | ---: |\n| **粗体** | 2 |'
    const line = fixture(source)
    const row = line(3).table
    expect(row).toMatchObject({ columns: 2, header: false, align: ['left', 'right'] })
    expect(row.cells.map(cell => source.slice(cell.from, cell.to).trim())).toEqual(['**粗体**', '2'])
    expect(line(1).table.header).toBe(true)
    expect(line(2).table.separator).toBe(true)
  })

  it('does not split escaped pipes or inline-code content into extra cells', () => {
    const source = '| A | B |\n| --- | --- |\n| a\\|b | `c\\|d` |'
    const row = fixture(source)(3).table
    expect(row.cells).toHaveLength(2)
    expect(row.cells.map(cell => source.slice(cell.from, cell.to).trim())).toEqual(['a\\|b', '`c\\|d`'])
  })

  it('keeps HTML literal and protects list indentation from code misclassification', () => {
    const line = fixture('- 父项\n    - 子项\n\n<div onclick="alert(1)">\n**字面内容**\n</div>')
    expect(line(2)).toMatchObject({ listDepth: 2, literal: false })
    expect(line(4)).toMatchObject({ literal: true, html: true })
    expect(line(5)).toMatchObject({ literal: true, html: true })
  })

  it('hides only explicit hard-break syntax while preserving soft source line breaks', () => {
    const source = '软换行\n续行\n\n硬换行  \n续行\n\n反斜杠\\\n续行'
    const line = fixture(source)
    expect(line(1).hardBreak).toBeUndefined()
    expect(line(4).hardBreak).toBe(true)
    expect(line(4).markers.map(marker => source.slice(marker.from, marker.to))).toEqual(['  '])
    expect(line(7).hardBreak).toBe(true)
    expect(line(7).markers.map(marker => source.slice(marker.from, marker.to))).toEqual(['\\'])
  })

  it('reads a table alignment row only once per immutable parse tree', () => {
    const source = '| A | B |\n| --- | --- |\n' + Array(100).fill('| x | y |').join('\n')
    const doc = Text.of(source.split('\n')), tree = markdownLanguage.parser.parse(source)
    const delimiter = doc.line(2)
    let reads = 0
    const bounded = { length: doc.length, lineAt: (offset: number) => doc.lineAt(offset), sliceString: (from: number, to: number) => {
      if (from === delimiter.from && to === delimiter.to) reads++
      return doc.sliceString(from, to)
    } }
    for (let row = 3; row <= doc.lines; row++) expect(getContinuousBlockLine(bounded, tree, doc.line(row)).table.columns).toBe(2)
    expect(reads).toBe(1)
  })
})
