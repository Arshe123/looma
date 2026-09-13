import type MarkdownIt from 'markdown-it'
import type { Node } from '@tiptap/pm/model'

const visibleText = (text: string) => text
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
  .replace(/(?:https?:\/\/|mailto:)[^\s<>]+/gi, ' ')

/** Reading is an estimate, not code/image comprehension time. */
export const estimateReadingMinutes = (text: string): number => {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0
  const words = text.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0
  return Math.ceil(han / 400 + words / 200)
}

const inlineText = (tokens: MarkdownIt.Token[]): string => tokens.map(token => {
  if (token.type === 'text' || token.type === 'code_inline') return token.content
  if (token.type === 'softbreak' || token.type === 'hardbreak' || token.type === 'image') return ' '
  return ''
}).join('')

export const readMarkdownReadingMinutes = (tokens: MarkdownIt.Token[]) =>
  estimateReadingMinutes(visibleText(tokens.filter(token => token.type === 'inline')
    .map(token => inlineText(token.children ?? [])).join('\n')))

export const findMarkdownNoteTitle = (tokens: MarkdownIt.Token[]): number | null => {
  const first = tokens[0]
  return first?.type === 'heading_open' && first.tag === 'h1'
    && visibleText(inlineText(tokens[1]?.children ?? [])).trim()
    ? first.map?.[0] ?? null : null
}

export const readDocumentReadingMinutes = (doc: Node): number => {
  const parts: string[] = []
  doc.descendants(node => {
    if (node.type.name === 'codeBlock' || node.type.name === 'image') { parts.push(' '); return false }
    if (node.isBlock || node.type.name === 'hardBreak') parts.push('\n')
    if (node.isText) parts.push(node.text ?? '')
    return true
  })
  return estimateReadingMinutes(visibleText(parts.join('')))
}

export const findDocumentNoteTitle = (doc: Node): { from: number; to: number } | null => {
  for (let index = 0, from = 0; index < doc.childCount; index++) {
    const node = doc.child(index)
    // Whitespace paragraphs are empty; inline atoms (notably images) are not.
    if (node.type.name === 'paragraph' && !node.textBetween(0, node.content.size, '', '\uFFFC').trim()) {
      from += node.nodeSize
      continue
    }
    return node.type.name === 'heading' && node.attrs.level === 1 && visibleText(node.textContent).trim()
      ? { from, to: from + node.nodeSize } : null
  }
  return null
}

export const readingTimeLabel = (minutes: number | null) => minutes === null
  ? '阅读时间待全文加载' : `预计阅读 ${Math.max(1, minutes)} 分钟`
