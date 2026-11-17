import { describe, expect, it } from 'vitest'
import { adjustGraphCard, createGraphCard, placeGraphCard } from '../floating-graph-card'

describe('graph cards in world coordinates', () => {
  const bounds = { x: 430, y: 180, width: 320, height: 400 }
  it.each([.5, 1, 2])('converts movement and resizing at scale %s to world units', scale => {
    expect(adjustGraphCard(bounds, 40, -20, scale, 'move'))
      .toEqual({ ...bounds, x: 430 + 40 / scale, y: 180 - 20 / scale })
    const resized = adjustGraphCard(bounds, 40, 20, scale, 'resize')
    expect(resized.width).toBeGreaterThan(bounds.width)
    expect(resized.width / bounds.width).toBeCloseTo(resized.height / bounds.height)
    expect(resized.x).toBe(bounds.x)
    expect(resized.y).toBe(bounds.y)
  })
  it('permits placements anywhere in the world without window clamping', () => {
    expect(adjustGraphCard(bounds, -1000, -800, 1, 'move')).toEqual({ ...bounds, x: -570, y: -620 })
    const large = adjustGraphCard(bounds, 2000, 1000, 1, 'resize')
    expect(large.width).toBeGreaterThan(1000)
    expect(large.width / large.height).toBeCloseTo(bounds.width / bounds.height)
    expect(adjustGraphCard(bounds, -2000, -1000, 1, 'resize')).toEqual({ ...bounds, width: 80, height: 100 })
  })
  it.each([.2, 1, 2])('opens a card at a viewport-based readable size at graph zoom %s', scale => {
    const card = createGraphCard(600, 400, { x: -100, y: -100, scale }, { width: 360, height: 580 })
    expect(card.width * scale).toBeCloseTo(360 * .82)
    expect(card.height * scale).toBeCloseTo(580 * .72)
    expect(card.width / card.contentWidth! * scale).toBeCloseTo(1)
    const resized = adjustGraphCard(card, 80, 50, scale, 'resize')
    expect(resized.contentWidth).toBe(card.contentWidth)
    expect(resized.contentHeight).toBe(card.contentHeight)
    expect(resized.width / card.width).toBeCloseTo(resized.height / card.height)
  })
  it('uses the graph viewport rather than the app window to size a new card', () => {
    const camera = { x: 0, y: 0, scale: 1 }
    const small = createGraphCard(0, 0, camera, { width: 280, height: 320 })
    const large = createGraphCard(0, 0, camera, { width: 900, height: 800 })
    expect(small.width).toBeLessThan(large.width)
    expect(small.height).toBeLessThan(large.height)
  })
  it('places a new card within the visible area without altering its world size', () => {
    const camera = { x: -300, y: -100, scale: .5 }
    const result = placeGraphCard(bounds, camera, { width: 360, height: 500 })
    expect(result.width).toBe(320)
    expect(result.height).toBe(400)
    expect(result.x * camera.scale + camera.x).toBeGreaterThanOrEqual(8)
    expect(result.y * camera.scale + camera.y).toBeGreaterThanOrEqual(8)
  })
})
