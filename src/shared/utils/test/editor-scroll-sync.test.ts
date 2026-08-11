import { describe, expect, it } from 'vitest'
import {
  getOffsetForSourceLine,
  getSourceLineAtOffset,
} from '../editor-scroll-sync'

const anchors = [
  { line: 1, top: 0 },
  { line: 5, top: 100 },
  { line: 9, top: 300 },
]

describe('editor scroll source-line interpolation', () => {
  it('maps a viewport offset between rendered anchors to a fractional source line', () => {
    expect(getSourceLineAtOffset(anchors, 50)).toBe(3)
    expect(getSourceLineAtOffset(anchors, 200)).toBe(7)
  })

  it('maps a fractional source line back to a rendered offset', () => {
    expect(getOffsetForSourceLine(anchors, 3)).toBe(50)
    expect(getOffsetForSourceLine(anchors, 7)).toBe(200)
  })

  it('clamps positions outside the mapped range to the nearest anchor', () => {
    expect(getSourceLineAtOffset(anchors, -20)).toBe(1)
    expect(getSourceLineAtOffset(anchors, 500)).toBe(9)
    expect(getOffsetForSourceLine(anchors, -2)).toBe(0)
    expect(getOffsetForSourceLine(anchors, 20)).toBe(300)
  })

  it('ignores duplicate or invalid anchors without producing NaN', () => {
    const noisy = [
      { line: 1, top: 0 },
      { line: 1, top: 20 },
      { line: Number.NaN, top: 40 },
      { line: 5, top: 100 },
    ]
    expect(getSourceLineAtOffset(noisy, 50)).toBe(3)
    expect(getOffsetForSourceLine(noisy, 3)).toBe(50)
  })

  it('drops source anchors that move backwards in the rendered document', () => {
    const outOfOrder = [
      { line: 1, top: 100 },
      { line: 2, top: 50 },
      { line: 3, top: 60 },
    ]
    expect(getSourceLineAtOffset(outOfOrder, 200)).toBe(1)
    expect(getOffsetForSourceLine(outOfOrder, 3)).toBe(100)
  })
})
