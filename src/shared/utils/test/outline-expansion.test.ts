import { describe, expect, it } from 'vitest'
import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'
import { resolveOutlineExpandedIds } from '../outline-tree'

const heading = (id: string, level: number): MarkdownOutlineItem => ({
  id,
  index: Number(id.replace(/\D/g, '')) || 0,
  level,
  text: id,
  line: 1,
})

describe('resolveOutlineExpandedIds', () => {
  const items = [heading('heading-0', 1), heading('heading-1', 2), heading('heading-2', 3)]

  it('expands first-level sections below a single document title by default', () => {
    expect(resolveOutlineExpandedIds(items, [], [], true, false)).toEqual(['heading-0', 'heading-1'])
  })

  it('expands every root heading when the document has no single title root', () => {
    const roots = [heading('heading-0', 2), heading('heading-1', 3), heading('heading-2', 2)]

    expect(resolveOutlineExpandedIds(roots, [], [], true, false)).toEqual(['heading-0', 'heading-2'])
  })

  it('restores persisted expansion and removes headings that no longer exist', () => {
    expect(resolveOutlineExpandedIds(items, ['heading-1', 'removed'], [], true, true)).toEqual(['heading-1'])
  })

  it('automatically expands only newly added level-one headings while editing', () => {
    expect(resolveOutlineExpandedIds(
      [...items, heading('heading-3', 1), heading('heading-4', 2)],
      ['heading-1'],
      items.map((item) => item.id),
      false,
      true,
    )).toEqual(['heading-1', 'heading-3'])
  })

  it('automatically expands a new first-level section below the document title', () => {
    expect(resolveOutlineExpandedIds(
      [...items, heading('heading-3', 2)],
      ['heading-0'],
      items.map((item) => item.id),
      false,
      false,
    )).toEqual(['heading-0', 'heading-3'])
  })
})