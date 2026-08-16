export const MIN_RICH_TEXT_ZOOM = 75
export const MAX_RICH_TEXT_ZOOM = 200
export const DEFAULT_RICH_TEXT_ZOOM = 100
export const RICH_TEXT_ZOOM_STEP = 10

export const normalizeRichTextZoom = (value: unknown) => {
  const numericValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numericValue)) return DEFAULT_RICH_TEXT_ZOOM
  return Math.min(MAX_RICH_TEXT_ZOOM, Math.max(MIN_RICH_TEXT_ZOOM, Math.round(numericValue)))
}

export const getNextRichTextZoom = (current: number, deltaY: number) => {
  const normalized = normalizeRichTextZoom(current)
  if (deltaY === 0) return normalized
  const delta = deltaY < 0 ? RICH_TEXT_ZOOM_STEP : -RICH_TEXT_ZOOM_STEP
  return normalizeRichTextZoom(normalized + delta)
}
