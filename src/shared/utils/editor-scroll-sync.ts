const MARKDOWN_PREFIX_RE = /^\s{0,3}(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/
const MARKDOWN_DECORATION_RE = /[`*_~[\]()!>#|-]/g

export type SourceLineAnchor = {
  line: number
  top: number
}

const normalizeSourceLineAnchors = (anchors: SourceLineAnchor[]) => {
  const seenLines = new Set<number>()
  const sorted = anchors
    .filter(({ line, top }) => Number.isFinite(line) && Number.isFinite(top))
    .sort((a, b) => a.line - b.line || a.top - b.top)
    .filter(({ line }) => {
      if (seenLines.has(line)) return false
      seenLines.add(line)
      return true
    })

  return sorted.reduce<SourceLineAnchor[]>((normalized, anchor) => {
    const previous = normalized[normalized.length - 1]
    if (!previous || anchor.top > previous.top) normalized.push(anchor)
    return normalized
  }, [])
}

const interpolate = (value: number, from: number, to: number, targetFrom: number, targetTo: number) => {
  if (to <= from) return targetFrom
  const progress = (value - from) / (to - from)
  return targetFrom + progress * (targetTo - targetFrom)
}

export const getSourceLineAtOffset = (anchors: SourceLineAnchor[], offset: number) => {
  const normalized = normalizeSourceLineAnchors(anchors)
  if (normalized.length === 0) return null
  if (offset <= normalized[0].top) return normalized[0].line

  for (let index = 1; index < normalized.length; index++) {
    const previous = normalized[index - 1]
    const next = normalized[index]
    if (offset <= next.top) {
      return interpolate(offset, previous.top, next.top, previous.line, next.line)
    }
  }

  return normalized[normalized.length - 1].line
}

export const getOffsetForSourceLine = (anchors: SourceLineAnchor[], sourceLine: number) => {
  const normalized = normalizeSourceLineAnchors(anchors)
  if (normalized.length === 0) return null
  if (sourceLine <= normalized[0].line) return normalized[0].top

  for (let index = 1; index < normalized.length; index++) {
    const previous = normalized[index - 1]
    const next = normalized[index]
    if (sourceLine <= next.line) {
      return interpolate(sourceLine, previous.line, next.line, previous.top, next.top)
    }
  }

  return normalized[normalized.length - 1].top
}

export const clampScrollRatio = (ratio: number) => {
  if (!Number.isFinite(ratio)) return 0
  return Math.min(Math.max(ratio, 0), 1)
}

export const getScrollRatio = (element: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'> | null) => {
  if (!element) return 0
  const maxScroll = element.scrollHeight - element.clientHeight
  if (maxScroll <= 0) return 0
  return clampScrollRatio(element.scrollTop / maxScroll)
}

export const setScrollRatio = (
  element: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'> | null,
  ratio: number,
) => {
  if (!element) return
  const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
  element.scrollTop = Math.round(maxScroll * clampScrollRatio(ratio))
}

export const normalizeAnchorText = (value: string) =>
  value
    .replace(MARKDOWN_PREFIX_RE, '')
    .replace(MARKDOWN_DECORATION_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

export const findBestTextAnchor = (blocks: string[], rawAnchor: string) => {
  const anchor = normalizeAnchorText(rawAnchor)
  if (!anchor) return -1
  const shortAnchor = anchor.slice(0, 80)
  return blocks.findIndex((block) => normalizeAnchorText(block).includes(shortAnchor))
}

export const lineTextAtOffset = (content: string, offset: number) => {
  if (!content) return ''
  const safeOffset = Math.min(Math.max(Math.round(offset), 0), content.length)
  const start = content.lastIndexOf('\n', Math.max(0, safeOffset - 1)) + 1
  const endIndex = content.indexOf('\n', safeOffset)
  const end = endIndex === -1 ? content.length : endIndex
  return content.slice(start, end)
}
