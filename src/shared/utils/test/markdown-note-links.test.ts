import { describe, expect, it } from 'vitest'
import { normalizeMarkdownNoteLinks } from '../markdown-note-links'
import { renderMarkdown } from '../markdown-renderer'
import { parseNoteLinkHref } from '../note-link-ref'

describe('legacy note destination normalization', () => {
  it.each([
    ['[x](a b.md#A  B)', '[x](a%20b.md#A%20%20B)'],
    ['[x](a b.txt#L12)', '[x](a%20b.txt#L12)'],
    ['[x](a%20b.md#A B)', '[x](a%20b.md#A%20B)'],
    ['[x](a b(1).md#A B)', '[x](a%20b(1).md#A%20B)'],
    ['[x](a b.md "提示 文字")', '[x](a%20b.md "提示 文字")'],
    ["[x](a b.md '提示 文字')", "[x](a%20b.md '提示 文字')"],
    ['[x](a b.md (提示 文字))', '[x](a%20b.md (提示 文字))'],
    ['[x](<a b.md#A B>)', '[x](<a%20b.md#A%20B>)'],
    ['- [x](a b.md)\r\n', '- [x](a%20b.md)\r\n'],
    ['> [x](a b.md)\n', '> [x](a%20b.md)\n'],
  ])('normalizes %s without changing surrounding source', (source, expected) => {
    expect(normalizeMarkdownNoteLinks(source)).toBe(expected)
    expect(normalizeMarkdownNoteLinks(expected)).toBe(expected)
  })

  it.each([
    '```md\n[x](a b.md)\n```',
    '~~~\n[x](a b.md)\n~~~',
    '    [x](a b.md)',
    '> ```md\n> [x](a b.md)\n> ```',
    '`[x](a b.md)`',
    '``code `[x](a b.md)` ``',
    '`code\n[x](a b.md)\ncode`',
    '![x](a b.md)',
    '[x](https://example.com/a b.md)',
    '[x](image file.png)',
    '\\[x](a b.md)',
    '<div>\n[x](a b.md)\n</div>',
    '<span title="[x](a b.md)">text</span>',
  ])('does not rewrite protected syntax: %s', source => {
    expect(normalizeMarkdownNoteLinks(source)).toBe(source)
  })

  it('keeps parentheses in a quoted title separate from the destination', () => {
    expect(normalizeMarkdownNoteLinks('[x](a b.md "提示 ) 文字")')).toBe('[x](a%20b.md "提示 ) 文字")')
  })

  it('resolves the original Chinese filename and heading from rendered href', () => {
    const source = '[国家疾控管理后台](../医渡云相关信息.md#4. 国家疾控管理后台)'
    const href = /href="([^"]+)"/.exec(renderMarkdown(source))?.[1]
    expect(href).toBeTruthy()
    expect(parseNoteLinkHref(href!, 'docs/current.md')).toEqual({
      relativePath: '医渡云相关信息.md', anchor: { kind: 'heading', text: '4. 国家疾控管理后台' },
    })
  })
})
