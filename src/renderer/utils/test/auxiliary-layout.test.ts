import { describe, expect, it } from 'vitest'
import { clampAuxiliaryWidth, parseAuxiliaryWidth } from '../auxiliary-layout'

describe('辅助栏宽度', () => {
  it('restores only valid saved widths', () => {
    for (const value of [null, '', 'bad', '-1', 'Infinity']) expect(parseAuxiliaryWidth(value)).toBe(360)
    expect(parseAuxiliaryWidth('480')).toBe(480)
  })
  it('keeps the document at least 360px wide on desktop', () => {
    expect(clampAuxiliaryWidth(900, 1440, 320)).toBe(732)
    expect(clampAuxiliaryWidth(100, 1440, 320)).toBe(280)
    expect(clampAuxiliaryWidth(480, 1440, 320)).toBe(480)
  })
  it('limits floating panels to the viewport without reserving the file tree', () => {
    expect(clampAuxiliaryWidth(1200, 1024, 320)).toBe(948)
    expect(clampAuxiliaryWidth(900, 320, 236)).toBe(244)
  })
})
