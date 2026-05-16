export type ScrollSyncState = {
  ratio: number
  sourceOffset?: number
  sourceLineText?: string
  textOffset?: number
}

const MARKDOWN_PREFIX_RE = /^\s{0,3}(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/
const MARKDOWN_DECORATION_RE = /[`*_~[\]()!>#|-]/g

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
