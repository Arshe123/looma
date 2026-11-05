import { common, createLowlight } from 'lowlight'
import type { RootContent } from 'hast'

const lowlight = /* @__PURE__ */ createLowlight(common)
export type CodeHighlightSegment = { text: string; classes: string[] }

/** Same language aliases, autodetection and token classes for editor and readers. */
export const getCodeHighlightSegments = (source: string, language?: string | null): CodeHighlightSegment[] => {
  const segments: CodeHighlightSegment[] = []
  const visit = (nodes: RootContent[], inherited: string[] = []) => {
    for (const node of nodes) {
      if (node.type === 'text') segments.push({ text: node.value, classes: inherited })
      else if (node.type === 'element') {
        const own = node.properties.className
        const classes = Array.isArray(own) ? own.filter((value): value is string => typeof value === 'string') : []
        visit(node.children, [...inherited, ...classes])
      }
    }
  }
  try {
    const result = language && lowlight.registered(language)
      ? lowlight.highlight(language, source)
      : lowlight.highlightAuto(source)
    visit(result.children)
    return segments
  } catch {
    // Highlighting is presentation only. A failure must never hide source code.
    return [{ text: source, classes: [] }]
  }
}
