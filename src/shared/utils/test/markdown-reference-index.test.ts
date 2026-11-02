import { describe, expect, it } from 'vitest'
import { buildMarkdownReferenceIndex, normalizeMarkdownReference } from '../markdown-reference-index'

describe('background Markdown reference index', () => {
  it('resolves the first actual definition and normalizes labels, without reading literal code', () => {
    const source = '[ My  REF ]: <../目标.md#L2> "标题"\n\n[my ref]: wrong.md\n\n```\n[fake]: bad.md\n```\n\n    [other]: bad.md\n'
    const refs = buildMarkdownReferenceIndex(source)
    expect(refs.get(normalizeMarkdownReference('my\nref'))).toEqual({ href: '../%E7%9B%AE%E6%A0%87.md#L2', title: '标题' })
    expect(refs.has('FAKE')).toBe(false)
    expect(refs.has('OTHER')).toBe(false)
  })
  it('keeps prototype-looking and escaped labels as ordinary reference names', () => {
    const refs = buildMarkdownReferenceIndex('[__proto__]: a.md\n[a\\*b]: b.md\n')
    expect(refs.get(normalizeMarkdownReference('__proto__'))?.href).toBe('a.md')
    expect(refs.get(normalizeMarkdownReference('a\\*b'))?.href).toBe('b.md')
  })
})
