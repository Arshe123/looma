import { Autolink, type DelimiterType, type MarkdownExtension, type InlineContext } from '@lezer/markdown'
import type { SyntaxNode, Tree } from '@lezer/common'
import type { Text } from '@codemirror/state'
import { getInlineMarkdownSpans, type InlineMarkdownSpan } from '@/shared/utils/tiptap-inline-markdown'
import { decodeMarkdownInlineSource, normalizeMarkdownReference, type MarkdownReferenceIndex } from '@/shared/utils/markdown-reference-index'

type SourceDocument = Pick<Text, 'length' | 'lineAt' | 'sliceString'>
type Read = (from: number, to: number) => string | null
/** Empty format templates can temporarily look like a rule or opening fence. */
export function getContinuousEmptyInlineSource(doc: SourceDocument, selection?: { from: number; to: number }) {
  if (!selection || selection.from !== selection.to) return null
  const line = doc.lineAt(selection.from)
  return line.to - line.from === 4 && selection.from === line.from + 2 && /^(?:\*{4}|~{4}|={4}|_{4})$/.test(doc.sliceString(line.from, line.to))
    ? { from: line.from, to: line.to } : null
}
export type ContinuousInlineCache = Map<string, InlineMarkdownSpan | null>
const highlight: DelimiterType = { resolve: 'Highlight', mark: 'HighlightMark' }
const punct = (value: string) => /[\p{P}\p{S}]/u.test(value)
const punctuationSpans = new WeakMap<InlineContext, InlineMarkdownSpan[]>()
const autolink = Autolink.parseInline!.find(parser => parser.name === 'Autolink')!
// Conservative starters for the installed CommonMark/GFM and Looma inline rules.
// False positives use the original parser. Never truncate a long syntax span.
const inlineSyntaxStart = /[\\![*_`<&~=@\r\n]|www\.|https?:\/\/|mailto:|xmpp:/
const nonAsciiLiteralRun = /[\u0080-\uffff]+/y
const literalRun = /[^\\![\]*_`<&~=@\r\n]+/y
const autolinkCandidate = /www\.|https?:\/\/|mailto:|xmpp:|@/g
type AutolinkBoundary = { at: number; from: number }
const autolinkBoundaries = new WeakMap<InlineContext, AutolinkBoundary | null>()

/** Keep only the next candidate, not an array proportional to paragraph size. */
function nextAutolinkBoundary(cx: InlineContext, at: number): number {
  let boundary = autolinkBoundaries.get(cx)
  if (boundary === undefined || (boundary && at > boundary.at)) {
    autolinkCandidate.lastIndex = at
    const candidate = autolinkCandidate.exec(cx.text)
    // GFM email local parts accept 100 units and may themselves contain www.
    // Protect the lookbehind for every candidate, not just the next @ marker.
    boundary = candidate ? { at: candidate.index, from: Math.max(0, candidate.index - 100) } : null
    autolinkBoundaries.set(cx, boundary)
  }
  return boundary?.from ?? cx.text.length
}

/** Extend the shared incremental grammar, not a lexer restarted at viewport edges. */
export const continuousMarkdownSyntax: MarkdownExtension = {
  defineNodes: ['Highlight', 'HighlightMark'],
  parseBlock: [{
    name: 'LoomaLiteralParagraph', before: 'SetextHeading',
    leaf(_cx, firstLine) {
      if (firstLine.content.length < 32768) return null
      return {
        // Other leaf observers must still see subsequent lines (tables/setext).
        nextLine: () => false,
        finish(cx, leaf) {
          if (leaf.content.length < 32768 || inlineSyntaxStart.test(leaf.content)) return false
          // Reuse the parser's existing leaf string and preserve container marks.
          // No rope flattening, private parser mutation or viewport-local grammar.
          cx.addLeafElement(leaf, cx.elt('Paragraph', leaf.start, leaf.start + leaf.content.length))
          return true
        },
      }
    },
  }],
  parseInline: [{
    name: 'LoomaLiteralRun', before: 'Escape',
    parse(cx, next, pos) {
      if (cx.end - cx.offset < 32768) return -1
      const at = pos - cx.offset, limit = nextAutolinkBoundary(cx, at)
      if (limit <= at) {
        // Inside a potential URL/email, preserve every ASCII start for GFM.
        if (next <= 127) return -1
        nonAsciiLiteralRun.lastIndex = at
        return nonAsciiLiteralRun.test(cx.text) ? cx.offset + nonAsciiLiteralRun.lastIndex : -1
      }
      literalRun.lastIndex = 0
      // Bound the regex to this interval, so repeated candidates cannot make
      // each literal run rescan the remainder of a giant paragraph.
      if (!literalRun.test(cx.text.slice(at, limit))) return -1
      let end = at + literalRun.lastIndex, right = end
      while (cx.text.charCodeAt(right) === 32) right++
      if (cx.text.charCodeAt(right) === 10) {
        let left = end
        while (left > at && cx.text.charCodeAt(left - 1) === 32) left--
        if (right - left >= 2) end = left // Leave the full hard break to GFM.
      }
      return end > at ? cx.offset + end : -1
    },
  }, {
    // Installed GFM starts every alternative with ASCII (including email local
    // parts). Keep its parser/order, but avoid regex work for every CJK code unit.
    name: 'Autolink',
    parse: (cx, next, pos) => next > 127 ? -1 : autolink.parse(cx, next, pos),
  }, {
    name: 'LoomaHighlight', before: 'Emphasis',
    parse(cx, next, pos) {
      if (next !== 61 || cx.char(pos + 1) !== 61) return -1
      return cx.addDelimiter(highlight, pos, pos + 2, pos + 2 < cx.end && cx.char(pos + 2) !== 61, pos > cx.offset && cx.char(pos - 1) !== 61)
    },
  }, {
    name: 'LoomaPunctuationStrong', before: 'Emphasis',
    parse(cx, next, pos) {
      if (next !== 42 || cx.char(pos + 1) !== 42 || cx.char(pos + 2) === 42) return -1
      let end = cx.text.indexOf('**', pos + 2 - cx.offset) + cx.offset
      if (end <= pos + 2 || cx.char(end - 1) === 92 || cx.char(end + 2) === 42) return -1
      let body = cx.slice(pos + 2, end)
      const first = String.fromCodePoint(body.codePointAt(0)!)
      const last = body.slice(-2).match(/[\s\S]$/u)![0]
      if (!punct(first) && !punct(last)) return -1
      // Native emphasis leaves closers on its delimiter stack. Only consume
      // genuine openers from the shared grammar, never a closer before a link.
      // This runs once per incremental paragraph parse, not in view updates.
      let spans = punctuationSpans.get(cx)
      if (!spans) punctuationSpans.set(cx, spans = getInlineMarkdownSpans(cx.text))
      const span = spans.find(value => value.type === 'bold' && value.from + cx.offset === pos)
      if (!span) return -1
      end = span.to + cx.offset - 2
      body = cx.slice(pos + 2, end)
      return cx.addElement(cx.elt('StrongEmphasis', pos, end + 2, [cx.elt('EmphasisMark', pos, pos + 2),
        ...cx.parser.parseInline(body, pos + 2), cx.elt('EmphasisMark', end, end + 2)]))
    },
  }],
}

const formats: Record<string, InlineMarkdownSpan['type']> = { StrongEmphasis: 'bold', Emphasis: 'italic', Strikethrough: 'strike', Highlight: 'highlight', InlineCode: 'inlineCode', Escape: 'escape' }

function describeInline(doc: SourceDocument, node: SyntaxNode, references: MarkdownReferenceIndex | undefined, read: Read): InlineMarkdownSpan | null {
  const type = formats[node.name]
  if (type === 'escape') return { type, from: node.from, to: node.to, contentFrom: node.from + 1, contentTo: node.to }
  if (type) {
    const first = node.firstChild, last = node.lastChild
    if (!first || !last || first.from !== node.from || last.to !== node.to) return null
    let contentFrom = first.to, contentTo = last.from
    if (type === 'inlineCode' && contentTo - contentFrom <= 512) {
      const body = read(contentFrom, contentTo)
      if (body?.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body)) { contentFrom++; contentTo-- }
    }
    return { type, from: node.from, to: node.to, contentFrom, contentTo }
  }
  if (node.name !== 'Link' && node.name !== 'Autolink' && node.name !== 'URL') return null
  if (node.name === 'URL') {
    if (['Link', 'Autolink', 'Image', 'LinkReference'].includes(node.parent?.name ?? '')) return null
    const raw = read(node.from, node.to)
    return { type: 'link', from: node.from, to: node.to, contentFrom: node.from, contentTo: node.to, ...(raw !== null ? { href: decodeMarkdownInlineSource(raw), title: null } : {}) }
  }
  const first = node.firstChild, last = node.lastChild
  if (!first || !last) return null
  let url: SyntaxNode | null = null, title: SyntaxNode | null = null, labelEnd: number | undefined
  // Destinations/titles are in the tail. Do not walk a giant formatted label.
  for (let child: SyntaxNode | null = last, count = 0; child && count < 7; child = child.prevSibling, count++) {
    if (child.name === 'URL') url = child
    if (child.name === 'LinkTitle') title = child
    if (child.name === 'LinkMark' && child.from > node.from && read(child.from, child.to) === ']') { labelEnd = child.from; break }
  }
  if (node.name === 'Autolink' && url) labelEnd = url.to
  const contentFrom = node.name === 'Autolink' && url ? url.from : first.to
  if (labelEnd === undefined) return null
  if (url) {
    const raw = read(url.from, url.to)
    const rawTitle = title ? read(title.from + 1, title.to - 1) : null
    return { type: 'link', from: node.from, to: node.to, contentFrom, contentTo: labelEnd,
      ...(raw !== null ? { href: decodeMarkdownInlineSource(raw.startsWith('<') ? raw.slice(1, -1) : raw), title: rawTitle === null ? null : decodeMarkdownInlineSource(rawTitle) } : {}) }
  }
  const explicit = last.name === 'LinkLabel' && last.to - last.from > 2
  const label = explicit ? read(last.from + 1, last.to - 1) : read(contentFrom, labelEnd)
  const reference = label === null ? undefined : references?.get(normalizeMarkdownReference(label))
  return reference ? { type: 'link', from: node.from, to: node.to, contentFrom, contentTo: labelEnd, ...reference } : null
}

/** Source reads are small; enclosing ranges come directly from the immutable tree. */
export function getContinuousInlineSpans(doc: SourceDocument, tree: Tree, from: number, to: number,
  references?: MarkdownReferenceIndex, reader?: Read, cache: ContinuousInlineCache = new Map()): InlineMarkdownSpan[] {
  const read: Read = reader ?? ((a, b) => {
    if (b - a > 8192) return null
    const parts = []
    for (let at = a; at < b; at += 2560) parts.push(doc.sliceString(at, Math.min(b, at + 2560)))
    return parts.join('')
  })
  const spans: InlineMarkdownSpan[] = []
  tree.iterate({ from, to, enter(ref) {
    if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'LinkReference', 'Image'].includes(ref.name)) return false
    if (formats[ref.name] || ['Link', 'Autolink', 'URL'].includes(ref.name)) {
      const key = `${ref.name}:${ref.from}:${ref.to}`
      if (!cache.has(key)) cache.set(key, describeInline(doc, ref.node, references, read))
      const span = cache.get(key)
      if (span) spans.push(span)
      if (ref.name === 'InlineCode' || ref.name === 'Autolink') return false
    }
  } })
  return spans
}
