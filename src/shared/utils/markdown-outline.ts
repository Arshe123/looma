import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'

const headingPattern = /^(#{1,6})(?:\s+|$)(.*)$/
const fencePattern = /^(\s*)(`{3,}|~{3,})/

export const parseMarkdownOutline = (content: string): MarkdownOutlineItem[] => {
  const lines = (content || '').split(/\r?\n/)
  const outline: MarkdownOutlineItem[] = []
  let fenceMarker = ''

  lines.forEach((line, lineIndex) => {
    const fenceMatch = line.match(fencePattern)
    if (fenceMatch) {
      const marker = fenceMatch[2]
      const markerChar = marker[0]
      if (!fenceMarker) {
        fenceMarker = markerChar
      } else if (fenceMarker === markerChar) {
        fenceMarker = ''
      }
      return
    }

    if (fenceMarker) return

    const match = line.match(headingPattern)
    if (!match) return

    const level = match[1].length
    const rawText = match[2].replace(/\s+#+\s*$/, '').trim()
    const index = outline.length
    outline.push({
      id: `heading-${index}`,
      index,
      level,
      text: rawText || '未命名标题',
      line: lineIndex + 1,
    })
  })

  return outline
}
