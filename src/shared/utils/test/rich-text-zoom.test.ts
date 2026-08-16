import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RICH_TEXT_ZOOM,
  getNextRichTextZoom,
  normalizeRichTextZoom,
} from '../rich-text-zoom'

describe('rich-text zoom', () => {
  it('normalizes persisted zoom values into the supported range', () => {
    expect(normalizeRichTextZoom(undefined)).toBe(DEFAULT_RICH_TEXT_ZOOM)
    expect(normalizeRichTextZoom('125')).toBe(125)
    expect(normalizeRichTextZoom(74)).toBe(75)
    expect(normalizeRichTextZoom(201)).toBe(200)
  })

  it('changes zoom by one step from the wheel direction', () => {
    expect(getNextRichTextZoom(100, -1)).toBe(110)
    expect(getNextRichTextZoom(100, 1)).toBe(90)
    expect(getNextRichTextZoom(100, 0)).toBe(100)
  })

  it('does not move beyond either zoom boundary', () => {
    expect(getNextRichTextZoom(75, 1)).toBe(75)
    expect(getNextRichTextZoom(200, -1)).toBe(200)
  })
})
