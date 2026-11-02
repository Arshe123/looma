import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { buildContinuousMarkdownPlan, getContinuousMarkdownLinkAt } from '../continuousMarkdown'

const contextAt = () => ({ fence: '', fenceLength: 0 })
const metadata = () => null
const planFor = (source: string) => {
  const doc = Text.of(source.split('\n'))
  return buildContinuousMarkdownPlan(doc, [{ from: 0, to: doc.length }], { contextAt, metadata })
}

describe('continuous Markdown presentation', () => {
  it('plans classified link runs with one icon per nested reference and preserves title', () => {
    const source = '前 [**完整** *引用*](note.md#L2 "说明") 后 [外部](https://example.com)'
    const plan = planFor(source)
    const links = plan.marks.filter(mark => mark.href)
    const notes = links.filter(mark => mark.attributes?.['data-looma-note-ref'])
    expect(notes.map(mark => source.slice(mark.from, mark.to))).toEqual(['完整', ' ', '引用'])
    expect(notes.every(mark => mark.className.includes('looma-note-ref') && mark.attributes?.title === '说明')).toBe(true)
    expect(notes.filter(mark => !mark.attributes?.['data-inline-markdown-link-continuation'])).toHaveLength(1)
    expect(links.find(mark => mark.href === 'https://example.com')?.className).toContain('looma-external-link')
  })
  it('expands the enclosing inline source at both boundaries without exposing unrelated formats', () => {
    const source = '前文 [**粗体** 标签](note.md#L2) 后文 ==高亮=='
    const doc = Text.of([source])
    const from = source.indexOf('['), to = source.indexOf(')') + 1
    for (const cursor of [from, from + 1, source.indexOf('粗体') + 1, to]) {
      const plan = buildContinuousMarkdownPlan(doc, [{ from: 0, to: doc.length }], { contextAt, metadata }, { from: cursor, to: cursor })
      expect(plan.marks.filter(mark => mark.className === 'looma-continuous-expanded-source')).toEqual([
        { from, to, className: 'looma-continuous-expanded-source' },
      ])
      expect(plan.replacements.some(range => range.from < to && range.to > from)).toBe(false)
      expect(plan.marks.some(mark => mark.className === 'looma-continuous-highlight')).toBe(true)
      expect(plan.marks.some(mark => mark.className === 'looma-continuous-bold')).toBe(false)
      expect(doc.toString()).toBe(source)
    }
    const inactive = buildContinuousMarkdownPlan(doc, [{ from: 0, to: doc.length }], { contextAt, metadata })
    expect(inactive.marks.some(mark => mark.className === 'looma-continuous-expanded-source')).toBe(false)
    expect(inactive.marks.some(mark => mark.className === 'looma-continuous-bold')).toBe(true)
  })

  it('highlights separate selected inline sources without painting plain text or code blocks', () => {
    const source = '前 **外层 *内层* 文字** 后\n\n隔开的 ==高亮==\n\n```\n**字面内容**\n```'
    const doc = Text.of(source.split('\n'))
    const codeFrom = source.indexOf('```')
    const plan = buildContinuousMarkdownPlan(doc, [{ from: 0, to: doc.length }], {
      contextAt: offset => ({ fence: offset > codeFrom ? '`' : '', fenceLength: 3 }), metadata,
    }, { from: 0, to: doc.length })
    expect(plan.marks.map(mark => source.slice(mark.from, mark.to))).toEqual(['**外层 *内层* 文字**', '==高亮=='])
    expect(plan.replacements).toEqual([])
  })

  it('looks up an expanded link in bounded source without parsing literal code', () => {
    const source = '普通'.repeat(1200) + ' [**引用**](other.md#L7 "标题") 末尾 `一个 [假链接](bad.md)`'
    const doc = Text.of([source])
    const reads: number[] = []
    const bounded = { length: doc.length, lineAt: (offset: number) => doc.lineAt(offset), sliceString: (from: number, to: number) => { reads.push(to - from); return doc.sliceString(from, to) } }
    expect(getContinuousMarkdownLinkAt(bounded, source.indexOf('引用'))).toMatchObject({ href: 'other.md#L7', title: '标题' })
    expect(getContinuousMarkdownLinkAt(bounded, source.indexOf('假链接'))).toBeUndefined()
    expect(Math.max(...reads)).toBeLessThanOrEqual(2560)
  })

  it('plans display-only local images and reading metadata without rewriting source', () => {
    const source = '# Title\n\n![原图](assets/image.png "原始标题"){width=60%}\n\n![bad](javascript:alert)'
    const doc = Text.of(source.split('\n'))
    const plan = buildContinuousMarkdownPlan(doc, [{ from: 0, to: doc.length }], {
      contextAt, metadata: () => ({ line: 0, minutes: 2, words: 345 }),
    })
    expect(plan.images).toHaveLength(1)
    expect(plan.images[0]).toMatchObject({ src: 'assets/image.png', alt: '原图', title: '原始标题', widthPercent: 60 })
    expect(source.slice(plan.images[0].from, plan.images[0].to)).toBe('![原图](assets/image.png "原始标题"){width=60%}')
    expect(plan.title).toMatchObject({ at: 7, minutes: 2, words: 345 })
    expect(doc.toString()).toBe(source)
  })
  it('presents headings and inline syntax without altering source or depending on selection', () => {
    const source = '\n# Title **bold**\n- item\n> quote\n1. ordered\nplain *italic* ~~gone~~ ==lit== `**literal**`'
    const plan = planFor(source)
    expect(plan.lines.find(line => line.line === 2)).toMatchObject({ from: 1, className: 'looma-continuous-line looma-continuous-heading looma-continuous-h1' })
    expect(plan.lines.map(line => line.line)).toEqual([1, 2, 3, 4, 5, 6])
    expect(plan.marks.map(mark => mark.className)).toEqual(expect.arrayContaining(['looma-continuous-bold', 'looma-continuous-italic', 'looma-continuous-strike', 'looma-continuous-highlight', 'looma-continuous-code']))
    expect(plan.marks.filter(mark => mark.className === 'looma-continuous-bold')).toHaveLength(1)
    expect(plan.replacements.map(range => source.slice(range.from, range.to))).toContain('# ')
    expect(plan.lines.find(line => line.line === 3)?.className).toContain('looma-continuous-list')
    expect(plan.lines.find(line => line.line === 4)?.className).toContain('looma-continuous-quote')
    expect(plan.lines.find(line => line.line === 5)?.className).toContain('looma-continuous-list')
    expect(planFor(source)).toEqual(plan)
    expect(source).toContain('**bold**')
  })
  it('keeps fenced and indented code literal even when a viewport starts deep inside a fence', () => {
    const source = '```md\n# **not a heading**\n![not image](assets/a.png)\n```\n    # **indented**\n\t**tab code**\n# **real**'
    const doc = Text.of(source.split('\n'))
    const fenceEnd = source.indexOf('\n```', 5) + 1
    const options = { contextAt: (offset: number) => ({ fence: offset > 0 && offset <= fenceEnd ? '`' : '', fenceLength: 3 }), metadata }
    const plan = buildContinuousMarkdownPlan(doc, [{ from: 8, to: doc.length }], options)
    expect(plan.marks.map(mark => source.slice(mark.from, mark.to))).toEqual(['real'])
    expect(plan.replacements.every(range => range.from >= source.lastIndexOf('# **real**'))).toBe(true)
    expect(plan.lines.filter(line => line.className.includes('heading')).map(line => line.line)).toEqual([7])
    expect(plan.lines.filter(line => line.className.includes('looma-continuous-code-block'))).toHaveLength(6)
    const longDoc = Text.of(('```\n' + 'literal\n'.repeat(1000) + '# **still literal**\n```').split('\n'))
    const deep = buildContinuousMarkdownPlan(longDoc, [{ from: 7900, to: longDoc.length }], { contextAt: () => ({ fence: '`', fenceLength: 3 }), metadata })
    expect(deep.marks).toEqual([])
    expect(deep.replacements).toEqual([])
  })

  it('reads only bounded visible windows with a hard per-build character budget', () => {
    const doc = Text.of(['a'.repeat(200_000)])
    const reads: number[] = []
    const boundedDoc = {
      length: doc.length,
      lineAt: (offset: number) => doc.lineAt(offset),
      sliceString: (from: number, to: number) => {
        reads.push(to - from)
        return doc.sliceString(from, to)
      },
    }
    const plan = buildContinuousMarkdownPlan(boundedDoc, [{ from: 80_000, to: 150_000 }], { contextAt, metadata })
    expect(plan.windows.length).toBeGreaterThan(0)
    expect(plan.windows.every(window => window.to - window.from <= 2560)).toBe(true)
    expect(Math.max(...reads)).toBeLessThanOrEqual(2560)
    expect(reads.reduce((total, count) => total + count, 0)).toBeLessThanOrEqual(32768)
    expect(plan.scanned).toBeLessThanOrEqual(32768)
    expect(plan.windows[0].from).toBeGreaterThan(75_000)
  })
})
