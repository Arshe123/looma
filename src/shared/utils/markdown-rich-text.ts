import type { JSONContent } from '@tiptap/core'
import { marked } from 'marked'
import { normalizeMarkdownNoteLinks } from './markdown-note-links'
import { markdownInlineExtensions } from './markdown-inline-grammar'

type MarkdownAstEditor = {
  getJSON: () => JSONContent
  markdown?: {
    serialize: (document: JSONContent) => string
  }
}

// Keep editor parsing and readonly rendering on the same Looma extension grammar.
marked.use({ extensions: markdownInlineExtensions })

export const serializeMarkdownAst = (editor: MarkdownAstEditor): string => {
  if (!editor.markdown) throw new Error('Markdown serializer is not initialized.')
  return normalizeMarkdownNoteLinks(editor.markdown.serialize(editor.getJSON()))
}

const isFenceLine = (line: string) => /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
const isStandaloneImageLine = (line: string) =>
  /^[\t ]*!\[[^\]\r\n]*\]\([^\r\n]*\)[\t ]*(?:\r?\n)?$/.test(line)

export const prepareMarkdownForRichText = (markdown: string) => {
  const lines = normalizeMarkdownNoteLinks(markdown).match(/.*(?:\r?\n|$)/g)?.filter(Boolean) || []
  let fence: string | null = null

  return lines.map((line, index) => {
    const marker = isFenceLine(line)
    if (marker) {
      if (!fence) fence = marker[0]
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      return line
    }

    const nextLine = lines[index + 1]
    if (!fence && nextLine && nextLine.trim() && isStandaloneImageLine(line)) {
      return line.endsWith('\r\n') ? `${line}\r\n` : line.endsWith('\n') ? `${line}\n` : `${line}\n\n`
    }
    return line
  }).join('')
}
