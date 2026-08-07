import { describe, expect, it } from 'vitest'
import {
  buildNoteRefRelativePath,
  isHeadingAnchorMatch,
  isInternalNoteHref,
  parseNoteLinkAnchor,
  parseNoteLinkHref,
} from '../note-link-ref'

describe('parseNoteLinkAnchor', () => {
  it('parses line anchor', () => {
    expect(parseNoteLinkAnchor('L12')).toEqual({ kind: 'line', line: 12 })
    expect(parseNoteLinkAnchor('l3')).toEqual({ kind: 'line', line: 3 })
  })

  it('parses line range anchor', () => {
    expect(parseNoteLinkAnchor('L12-15')).toEqual({ kind: 'line-range', start: 12, end: 15 })
  })

  it('parses heading anchor with URL encoding', () => {
    expect(parseNoteLinkAnchor('%E6%A0%87%E9%A2%98')).toEqual({ kind: 'heading', text: '标题' })
    expect(parseNoteLinkAnchor('简介')).toEqual({ kind: 'heading', text: '简介' })
  })

  it('returns undefined for empty or whitespace anchor', () => {
    expect(parseNoteLinkAnchor('')).toBeUndefined()
    expect(parseNoteLinkAnchor('   ')).toBeUndefined()
  })
})

describe('parseNoteLinkHref', () => {
  it('parses plain note link', () => {
    expect(parseNoteLinkHref('note.md', 'current.md')).toEqual({
      relativePath: 'note.md',
      anchor: undefined,
    })
  })

  it('parses heading anchor link', () => {
    expect(parseNoteLinkHref('note.md#%E6%A0%87%E9%A2%98', 'current.md')).toEqual({
      relativePath: 'note.md',
      anchor: { kind: 'heading', text: '标题' },
    })
  })

  it('parses line anchor link', () => {
    expect(parseNoteLinkHref('note.md#L12', 'current.md')).toEqual({
      relativePath: 'note.md',
      anchor: { kind: 'line', line: 12 },
    })
  })

  it('resolves paths relative to the current note directory', () => {
    expect(parseNoteLinkHref('note.md', 'docs/current.md')?.relativePath).toBe('docs/note.md')
    expect(parseNoteLinkHref('../note.md', 'docs/current.md')?.relativePath).toBe('note.md')
    expect(parseNoteLinkHref('./sub/note.md', 'docs/current.md')?.relativePath).toBe('docs/sub/note.md')
    expect(parseNoteLinkHref('a/b/../../note.md', 'docs/current.md')?.relativePath).toBe('docs/note.md')
  })

  it('returns null for external URLs', () => {
    expect(parseNoteLinkHref('https://example.com', 'current.md')).toBeNull()
    expect(parseNoteLinkHref('mailto:a@b.com', 'current.md')).toBeNull()
  })

  it('returns null for non-note extensions', () => {
    expect(parseNoteLinkHref('image.png', 'current.md')).toBeNull()
    expect(parseNoteLinkHref('page.html#top', 'current.md')).toBeNull()
  })

  it('returns null for bare anchors', () => {
    expect(parseNoteLinkHref('#标题', 'current.md')).toBeNull()
  })

  it('handles txt notes', () => {
    expect(parseNoteLinkHref('note.txt#L2', 'current.md')?.relativePath).toBe('note.txt')
  })
})

describe('isInternalNoteHref', () => {
  it('recognizes md and txt links', () => {
    expect(isInternalNoteHref('note.md')).toBe(true)
    expect(isInternalNoteHref('note.md#L12')).toBe(true)
    expect(isInternalNoteHref('note.txt')).toBe(true)
  })

  it('rejects external and non-note links', () => {
    expect(isInternalNoteHref('https://example.com')).toBe(false)
    expect(isInternalNoteHref('image.png')).toBe(false)
    expect(isInternalNoteHref('#anchor')).toBe(false)
    expect(isInternalNoteHref('')).toBe(false)
  })
})

describe('isHeadingAnchorMatch', () => {
  it('matches ignoring case and surrounding whitespace', () => {
    expect(isHeadingAnchorMatch('标题', '标题')).toBe(true)
    expect(isHeadingAnchorMatch(' 标题 ', '标题')).toBe(true)
    expect(isHeadingAnchorMatch('Title', 'title')).toBe(true)
    expect(isHeadingAnchorMatch('标题', '另一个标题')).toBe(false)
    expect(isHeadingAnchorMatch('', '标题')).toBe(false)
  })
})

describe('buildNoteRefRelativePath', () => {
  it('resolves same-directory target', () => {
    expect(buildNoteRefRelativePath('docs/a.md', 'docs/b.md')).toBe('b.md')
  })

  it('resolves nested target with parent traversal', () => {
    expect(buildNoteRefRelativePath('docs/sub/a.md', 'docs/b.md')).toBe('../b.md')
    expect(buildNoteRefRelativePath('docs/sub/deep/a.md', 'docs/b.md')).toBe('../../b.md')
  })

  it('resolves target in deeper directory', () => {
    expect(buildNoteRefRelativePath('docs/a.md', 'docs/sub/b.md')).toBe('sub/b.md')
  })

  it('resolves root-level target from nested note', () => {
    expect(buildNoteRefRelativePath('医渡科技实习日记/第五天 26-8-7.md', '医渡云相关信息.md')).toBe('../医渡云相关信息.md')
  })

  it('returns target itself when from note is at root', () => {
    expect(buildNoteRefRelativePath('a.md', 'b.md')).toBe('b.md')
  })
})
