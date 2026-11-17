export interface FloatingGraphCardBounds {
  x: number; y: number; width: number; height: number
  contentWidth?: number
  contentHeight?: number
}

export interface GraphCardCamera { x: number; y: number; scale: number }

/** Start at a readable screen size derived from this particular graph viewport. */
export function createGraphCard(x: number, y: number, camera: GraphCardCamera, viewport: { width: number; height: number }): FloatingGraphCardBounds {
  const contentWidth = Math.max(180, Math.min(380, viewport.width * .82))
  const contentHeight = Math.max(180, Math.min(440, viewport.height * .72))
  return placeGraphCard({ x, y, width: contentWidth / camera.scale, height: contentHeight / camera.scale,
    contentWidth, contentHeight }, camera, viewport)
}

/** Convert pointer travel to world units; never constrain placements to the window. */
export function adjustGraphCard(bounds: FloatingGraphCardBounds, dx: number, dy: number, scale: number, kind: 'move' | 'resize'): FloatingGraphCardBounds {
  const worldX = dx / scale, worldY = dy / scale
  if (kind === 'move') return { ...bounds, x: bounds.x + worldX, y: bounds.y + worldY }
  // Project the pointer onto the card diagonal, preserving the full composition
  // (text, icons, spacing and frame), rather than resizing its scroll viewport.
  const factor = Math.max((bounds.contentWidth || 320) * .25 / bounds.width,
    1 + (worldX * bounds.width + worldY * bounds.height) / (bounds.width ** 2 + bounds.height ** 2))
  return { ...bounds, width: bounds.width * factor, height: bounds.height * factor }
}

/** Only a brand-new card is placed within the currently visible area. */
export function placeGraphCard(bounds: FloatingGraphCardBounds, camera: GraphCardCamera, viewport: { width: number; height: number }): FloatingGraphCardBounds {
  const screenX = camera.x + bounds.x * camera.scale
  const screenY = camera.y + bounds.y * camera.scale
  const left = Math.max(8, Math.min(screenX, viewport.width - bounds.width * camera.scale - 8))
  const top = Math.max(8, Math.min(screenY, viewport.height - bounds.height * camera.scale - 8))
  return { ...bounds, x: (left - camera.x) / camera.scale, y: (top - camera.y) / camera.scale }
}
