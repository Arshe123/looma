import MarkdownIt from 'markdown-it'
import { isInternalNoteHref } from './note-link-ref'

const blockParser = new MarkdownIt({ html: true })

/** Encode only literal horizontal whitespace, without double-encoding existing escapes. */
export const normalizeNoteLinkHref = (href: string) =>
  isInternalNoteHref(href) ? href.replace(/[ \t]/g, char => char === ' ' ? '%20' : '%09') : href

const closingDelimiter = (source: string, start: number, open: string, close: string) => {
  let depth = 1
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') { index += 1; continue }
    if (open === '(' && (source[index] === '"' || source[index] === "'")
      && /[ \t]/.test(source[index - 1])) {
      const quote = source[index]
      let end = index + 1
      while (end < source.length && source[end] !== quote) {
        if (source[end] === '\\') end += 1
        end += 1
      }
      if (end < source.length) { index = end; continue }
    }
    if (open === '(' && source[index] === '<') {
      const end = source.indexOf('>', index + 1)
      if (end >= 0) { index = end; continue }
    }
    if (source[index] === open) depth += 1
    if (source[index] === close && --depth === 0) return index
  }
  return -1
}

const normalizeInlineLinks = (source: string) => {
  let output = ''
  let copied = 0
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\\') { index += 1; continue }
    if (source[index] === '`') {
      const run = /^`+/.exec(source.slice(index))![0]
      const rest = source.slice(index + run.length)
      const closing = new RegExp(`(?<!\x60)${run}(?!\x60)`).exec(rest)
      index += closing ? run.length + closing.index + run.length - 1 : run.length - 1
      continue
    }
    if (source[index] === '<') {
      const end = source.indexOf('>', index + 1)
      if (end >= 0) { index = end; continue }
    }
    if (source[index] !== '[') continue
    const labelEnd = closingDelimiter(source, index, '[', ']')
    if (labelEnd < 0 || source[labelEnd + 1] !== '(') continue
    const end = closingDelimiter(source, labelEnd + 1, '(', ')')
    if (end < 0) continue
    // Images use their own syntax and must remain untouched.
    if (index > 0 && source[index - 1] === '!') { index = end; continue }
    const targetStart = labelEnd + 2
    const target = source.slice(targetStart, end)
    if (/[\r\n]/.test(target)) { index = end; continue }
    const leading = /^[ \t]*/.exec(target)![0]
    const body = target.slice(leading.length)
    let destination: string
    let prefix = leading
    let suffix: string
    if (body.startsWith('<')) {
      const angleEnd = body.indexOf('>')
      if (angleEnd < 0) { index = end; continue }
      destination = body.slice(1, angleEnd)
      prefix += '<'
      suffix = body.slice(angleEnd)
    } else {
      // Keep the optional standard Markdown link title, including its spacing.
      const title = /[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^()\r\n]*\))[ \t]*$/.exec(body)
      const destinationEnd = title?.index ?? body.trimEnd().length
      destination = body.slice(0, destinationEnd)
      suffix = body.slice(destinationEnd)
    }
    const normalized = normalizeNoteLinkHref(destination)
    if (normalized !== destination) {
      output += source.slice(copied, targetStart) + prefix + normalized + suffix
      copied = end
    }
    index = end
  }
  return output + source.slice(copied)
}

/**
 * Normalize legacy inline note links while retaining the original source layout.
 * Block parsing limits edits to inline Markdown, excluding fenced/indented code
 * and raw HTML blocks. Inline code, images, titles and external links are preserved.
 */
export const normalizeMarkdownNoteLinks = (markdown: string): string => {
  if (!/[ \t]/.test(markdown) || !markdown.includes('](')) return markdown
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) || []
  const editable = new Set<number>()
  for (const token of blockParser.parse(markdown, {})) {
    if (token.type !== 'inline' || !token.map) continue
    for (let line = token.map[0]; line < token.map[1]; line += 1) editable.add(line)
  }
  let output = ''
  for (let index = 0; index < lines.length;) {
    if (!editable.has(index)) { output += lines[index++]; continue }
    let inline = ''
    while (index < lines.length && editable.has(index)) inline += lines[index++]
    output += normalizeInlineLinks(inline)
  }
  return output
}
