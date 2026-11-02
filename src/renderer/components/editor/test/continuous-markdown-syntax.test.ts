import { Text } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { describe, expect, it, vi } from 'vitest'
import { continuousMarkdownSyntax, getContinuousInlineSpans } from '../continuousMarkdownSyntax'
import { buildContinuousMarkdownPlan } from '../continuousMarkdown'
import { buildMarkdownReferenceIndex } from '@/shared/utils/markdown-reference-index'
import type { InlineContext, MarkdownConfig, MarkdownParser } from '@lezer/markdown'
import { TreeFragment, type Tree } from '@lezer/common'

const parser = markdown({ base: markdownLanguage, extensions: continuousMarkdownSyntax }).language.parser
const originalParagraphParser = markdown({ base: markdownLanguage, extensions: {
  ...continuousMarkdownSyntax as MarkdownConfig, parseBlock: [],
  parseInline: (continuousMarkdownSyntax as MarkdownConfig).parseInline?.filter(rule => rule.name !== 'LoomaLiteralRun'),
} }).language.parser
const options = { contextAt: () => ({ fence: '', fenceLength: 0 }), metadata: () => null }
const fixture = (source: string) => ({ doc: Text.of(source.split('\n')), tree: parser.parse(source) })
const nodeRanges = (tree: Tree) => {
  const nodes: [string, number, number][] = []
  tree.iterate({ enter: node => { nodes.push([node.name, node.from, node.to]) } })
  return nodes
}

describe('tree-backed bounded inline Markdown', () => {
  it('does not run the per-character inline parser for a proven literal long paragraph', () => {
    const longParser = markdown({ base: markdownLanguage, extensions: continuousMarkdownSyntax }).language.parser as MarkdownParser
    const inline = vi.spyOn(longParser, 'parseInline')
    try {
      const source = '普通文字'.repeat(10_000) + ' input123 😀é。'
      const tree = longParser.parse(source)
      expect(nodeRanges(tree)).toEqual([['Document', 0, source.length], ['Paragraph', 0, source.length]])
      expect(inline).not.toHaveBeenCalled()
    } finally { inline.mockRestore() }
  })
  it('jumps over non-ASCII literal runs without discarding enclosing long syntax', () => {
    let visits = 0
    const countingParser = markdown({ base: markdownLanguage, extensions: [continuousMarkdownSyntax, {
      parseInline: [{ name: 'VisitProbe', before: 'Escape', parse(_cx, next) { if (next > 127) visits++; return -1 } }],
    }] }).language.parser
    const body = '中文😀é'.repeat(7000)
    const source = '# **' + body + '** [标签](note.md)'
    expect(nodeRanges(countingParser.parse(source))).toEqual(nodeRanges(originalParagraphParser.parse(source)))
    expect(visits).toBeLessThan(10)
  })
  it('jumps over ASCII literal runs while preserving enclosing formatting and later autolinks', () => {
    let visits = 0
    const countingParser = markdown({ base: markdownLanguage, extensions: [continuousMarkdownSyntax, {
      parseInline: [{ name: 'AsciiVisitProbe', before: 'Escape', parse(_cx, next) { if (next === 97) visits++; return -1 } }],
    }] }).language.parser
    const source = '# **' + 'a'.repeat(40000) + '** http://example.com a+b@example.com'
    expect(nodeRanges(countingParser.parse(source))).toEqual(nodeRanges(originalParagraphParser.parse(source)))
    expect(visits).toBeLessThan(128)
  })
  it('does not skip an email local part that contains a URL-looking starter', () => {
    const source = '**' + '字'.repeat(40000) + '** localwww.example@example.com'
    expect(nodeRanges(parser.parse(source))).toEqual(nodeRanges(originalParagraphParser.parse(source)))
  })
  it('preserves long ASCII formatting, hard breaks and nearby URL/email boundaries', () => {
    const body = 'a'.repeat(34000)
    for (const tail of ['   \nnext', '  \n' + ' '.repeat(94) + 'a@b.com', '\r\nnext',
      ' localwww.example@example.com', ' '.repeat(110) + 'a@b.com',
      ' a'.repeat(100) + '@example.com', ' http://www.example.com/path?x=a@b.com',
      ' www.www.example.com www.invalid', ' [long label](https://example.com)',
      ' [reference][ref]\n\n[ref]: https://example.com', ' &amp; \\* <tag>',
      ' ==highlight== ~~strike~~ *emphasis* `literal`']) {
      const source = '**' + body + '**' + tail
      expect(nodeRanges(parser.parse(source))).toEqual(nodeRanges(originalParagraphParser.parse(source)))
    }
  })
  it('preserves all ASCII characters at long formatted-run boundaries', () => {
    const body = 'a'.repeat(32768)
    for (let code = 0; code < 128; code++) {
      const source = '**' + body + String.fromCharCode(code) + '尾**'
      expect(nodeRanges(parser.parse(source)), `formatted ASCII ${code}`).toEqual(nodeRanges(originalParagraphParser.parse(source)))
    }
  })
  it('keeps full node ranges for long literal container blocks and table/setext observers', () => {
    const body = '普通文字'.repeat(9000) + ' Latin123 😀é。'
    for (const source of [body, '> ' + body, '- ' + body, '1. ' + body,
      body + '\n---', '> ' + body + '\n> ---', body + '\n最后一行',
      body + ' | B\n--- | ---\n甲 | 乙', '- [ ] ' + body,
      '# ' + body, '    ' + body, '```\n' + body + '\n```']) {
      expect(nodeRanges(parser.parse(source))).toEqual(nodeRanges(originalParagraphParser.parse(source)))
    }
  })
  it('never bypasses real inline syntax at the far end of a long paragraph', () => {
    const body = '普通文字'.repeat(9000)
    for (const suffix of [' **粗体**', ' *斜体*', ' __加粗__', ' ~~删除~~', ' ==高亮==',
      ' `代码`', ' [文字](note.md)', ' ![图片](image.png)', ' [文字][ref]\n\n[ref]: note.md',
      ' <https://example.com>', ' <span>内容</span>', ' &amp;', ' &#x4e2d;',
      ' \\*正文', '  \n换行', ' www.example.com', ' https://example.com', ' http://example.com',
      ' a+b@example.com', ' mailto:a@example.com', ' xmpp:a@example.com/resource']) {
      const source = body + suffix
      expect(nodeRanges(parser.parse(source))).toEqual(nodeRanges(originalParagraphParser.parse(source)))
    }
  })
  it('preserves installed grammar for every ASCII character inside a long literal paragraph', () => {
    const body = '字'.repeat(32768)
    for (let code = 0; code < 128; code++) {
      const source = body + String.fromCharCode(code) + '正文'
      expect(nodeRanges(parser.parse(source)), `ASCII ${code}`).toEqual(nodeRanges(originalParagraphParser.parse(source)))
    }
  })
  it('invalidates the literal fast path when incremental edits introduce or remove Markdown', () => {
    const initial = '字'.repeat(40000)
    let tree = parser.parse(initial)
    for (const insert of [' **粗体**', ' ==高亮==', ' [链接](note.md)', ' www.example.com', ' a@example.com']) {
      const at = 23000
      const next = initial.slice(0, at) + insert + initial.slice(at)
      const added = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: at, toA: at, fromB: at, toB: at + insert.length }])
      tree = parser.parse(next, added)
      expect(nodeRanges(tree)).toEqual(nodeRanges(originalParagraphParser.parse(next)))
      const removed = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: at, toA: at + insert.length, fromB: at, toB: at }])
      tree = parser.parse(initial, removed)
      expect(nodeRanges(tree)).toEqual(nodeRanges(originalParagraphParser.parse(initial)))
    }
  })
  it('rejects non-ASCII autolink starts before reading paragraph text', () => {
    const rule = (continuousMarkdownSyntax as MarkdownConfig).parseInline?.find(rule => rule.name === 'Autolink')
    expect(rule).toBeDefined()
    const context = { get text(): string { throw new Error('non-ASCII start must not consult the autolink regex') } } as InlineContext
    for (const next of [0x4e2d, 0x00e9, 0xd83d, 0xdc69]) expect(rule!.parse(context, next, 0)).toBe(-1)
  })
  it.each(['中文 https://example.com/a(b) 与 www.example.com/test。', 'a+b@example.com .a@example.com -a@example.com _a@example.com', 'mailto:user@example.com xmpp:user@example.com/resource', 'éfoo@example.com 中abc@example.com [www.example.com](target.md)', '<https://example.com> `www.example.com` **www.example.com**'])('keeps installed GFM autolink semantics for %s', source => {
    const baseline = markdown({ base: markdownLanguage }).language.parser.parse(source)
    expect(nodeRanges(parser.parse(source))).toEqual(nodeRanges(baseline))
  })
  it('resolves full, collapsed and shortcut references from a supplied immutable background index only', () => {
    const source = '[**标签**][My Ref] [my ref][] [my ref] [缺失][unknown]\n\n[my ref]: <../目标.md#L2> "标题"'
    const { doc, tree } = fixture(source)
    const references = buildMarkdownReferenceIndex(source)
    const spans = getContinuousInlineSpans(doc, tree, 0, doc.length, references)
    expect(spans.filter(span => span.type === 'link')).toHaveLength(3)
    expect(spans.filter(span => span.type === 'link').every(span => span.href === '../%E7%9B%AE%E6%A0%87.md#L2')).toBe(true)
    expect(getContinuousInlineSpans(doc, tree, 0, doc.length).filter(span => span.type === 'link')).toEqual([])
  })
  it('retains true enclosing long syntax across windows without recognizing a truncated fragment', () => {
    const source = '**' + '字'.repeat(12_000) + '** [**标签**](../目标.md#L9)'
    const { doc, tree } = fixture(source)
    const spans = getContinuousInlineSpans(doc, tree, 7000, 7200)
    expect(spans).toContainEqual({ from: 0, to: 12004, contentFrom: 2, contentTo: 12002, type: 'bold' })
    const plan = buildContinuousMarkdownPlan(doc, [{ from: 7000, to: 7200 }], { ...options, tree })
    expect(plan.marks.some(mark => mark.className === 'looma-continuous-bold' && mark.from <= 7000 && mark.to >= 7200)).toBe(true)
    expect(plan.replacements).toEqual([{ from: 0, to: 2 }, { from: 12002, to: 12004 }])
  })

  it('expands the entire enclosing inline source with line-local decorations for multiline syntax', () => {
    const source = '前 **粗体\n续行** 后 [标签\n续行](../目标.md)'
    const { doc, tree } = fixture(source)
    const spans = getContinuousInlineSpans(doc, tree, 6, 20)
    expect(spans.filter(span => span.type === 'bold')).toHaveLength(1)
    expect(spans.find(span => span.type === 'link')).toMatchObject({ href: '../目标.md' })
    const cursor = source.indexOf('粗体') + 1
    const plan = buildContinuousMarkdownPlan(doc, [{ from: 0, to: doc.length }], { ...options, tree }, { from: cursor, to: cursor })
    expect(plan.marks.filter(mark => mark.className === 'looma-continuous-expanded-source').map(mark => source.slice(mark.from, mark.to))).toEqual(['**粗体', '续行**'])
    expect(plan.replacements.every(range => !source.slice(range.from, range.to).includes('\n'))).toBe(true)
  })

  it('parses highlight, punctuation-boundary emoji bold and nested code literally', () => {
    const source = '后续我在**🚨监控告警-海南监测系统-一期&二期**群 ==高亮\n续行== `**不要解析**`'
    const { doc, tree } = fixture(source)
    const spans = getContinuousInlineSpans(doc, tree, 0, doc.length)
    expect(spans.map(span => span.type)).toEqual(['bold', 'highlight', 'inlineCode'])
    expect(spans.filter(span => span.type === 'bold')).toHaveLength(1)
  })

  it('does not scan or stringify a long label or outside-viewport plain text', () => {
    const source = '[**' + '字'.repeat(50_000) + '**](note.md "标题")'
    const { doc, tree } = fixture(source)
    const reads: number[] = []
    const bounded = { length: doc.length, lineAt: (offset: number) => doc.lineAt(offset), sliceString: (from: number, to: number) => { reads.push(to - from); return doc.sliceString(from, to) } }
    const plan = buildContinuousMarkdownPlan(bounded, [{ from: 25_000, to: 25_200 }], { ...options, tree })
    expect(plan.marks.some(mark => mark.className.split(' ').includes('looma-continuous-link') && mark.href === 'note.md')).toBe(true)
    expect(plan.marks.some(mark => mark.className === 'looma-continuous-bold')).toBe(true)
    expect(Math.max(...reads)).toBeLessThanOrEqual(2560)
    expect(reads.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(32768)
  })
})
