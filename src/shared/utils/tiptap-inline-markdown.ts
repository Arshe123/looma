import { Extension, type Editor, type JSONContent } from '@tiptap/core'
import { Marked, type Token } from 'marked'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { isInternalNoteHref } from './note-link-ref'

// An independent lexer: the editor's MarkdownManager registers tokenizers on
// its own instance. Re-entering that instance here would recurse.
const inlineLexer = new Marked({ gfm: true })
inlineLexer.use({ extensions: [
  {
    name: 'highlight', level: 'inline', start: src => src.indexOf('=='),
    tokenizer(src) {
      // Same extension grammar as @tiptap/extension-highlight, without trimming
      // its source offsets. Standard Markdown is delegated to marked below.
      const match = /^(==)([^=]+)(==)/.exec(src)
      if (!match) return undefined
      return { type: 'highlight', raw: match[0], text: match[2], tokens: this.lexer.inlineTokens(match[2]) }
    },
  },
  {
    name: 'strong', level: 'inline', start: src => src.indexOf('**'),
    tokenizer(src) {
      // Looma's punctuation-boundary strong extension (markdown-rich-text).
      // Do not let the extension consume a closing triple delimiter as a pair.
      if (!src.startsWith('**') || src.startsWith('***')) return undefined
      const end = src.indexOf('**', 2)
      if (end <= 2 || src[end - 1] === '\\' || src[end + 2] === '*') return undefined
      if (!/[\p{P}\p{S}]/u.test(src[2]) && !/[\p{P}\p{S}]/u.test(src[end - 1])) return undefined
      const text = src.slice(2, end)
      return { type: 'strong', raw: src.slice(0, end + 2), text, tokens: this.lexer.inlineTokens(text) }
    },
  },
] })

export type InlineMarkdownFormat = 'bold' | 'italic' | 'strike' | 'inlineCode' | 'highlight'
export type InlineMarkdownSpan = {
  from: number; to: number; contentFrom: number; contentTo: number
  type: InlineMarkdownFormat | 'link' | 'escape'
  href?: string; title?: string | null
}
const tokenTypes: Record<string, InlineMarkdownSpan['type']> = {
  strong: 'bold', em: 'italic', del: 'strike', codespan: 'inlineCode', highlight: 'highlight', link: 'link', escape: 'escape',
}
const lex = (source: string) => inlineLexer.Lexer.lexInline(source, inlineLexer.defaults)

/** UTF-16 source offsets; nested spans are flattened, outer before inner. */
export const getInlineMarkdownSpans = (source: string): InlineMarkdownSpan[] => {
  const spans: InlineMarkdownSpan[] = []
  const walk = (tokens: Token[], base: number) => {
    let offset = base
    for (const token of tokens) {
      const from = offset
      const to = offset += token.raw.length
      const type = tokenTypes[token.type]
      if (!type) continue
      let opening = type === 'bold' || type === 'highlight' ? 2 : 1
      let closing = opening
      if (type === 'inlineCode') {
        opening = /^`+/.exec(token.raw)![0].length
        closing = opening
        const body = token.raw.slice(opening, -closing)
        if (body.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body)) { opening++; closing++ }
      } else if (type === 'strike') {
        opening = token.raw.startsWith('~~') ? 2 : 1
        closing = opening
      } else if (type === 'escape') closing = 0
      else if (type === 'link') {
        if (!token.raw.startsWith('[')) { opening = token.raw.startsWith('<') ? 1 : 0; closing = opening }
        else {
          // marked already validated the destination/title and balanced label.
          // Child raw strings retain escapes, unlike the decoded token.text.
          const label = 'tokens' in token && token.tokens ? token.tokens.map(t => t.raw).join('') : ''
          closing = token.raw.length - 1 - label.length
        }
      }
      const span: InlineMarkdownSpan = { from, to, type, contentFrom: from + opening, contentTo: to - closing }
      if (type === 'link' && 'href' in token) { span.href = token.href; span.title = token.title }
      spans.push(span)
      if ('tokens' in token && token.tokens) walk(token.tokens, span.contentFrom)
    }
  }
  walk(lex(source), 0)
  return spans
}

export const hasInlineMarkdownSource = (source: string): boolean => getInlineMarkdownSpans(source).length > 0

// ProseMirror nodes are immutable: only edited textblocks need re-lexing.
const spanCache = new WeakMap<ProseMirrorNode, InlineMarkdownSpan[]>()
const spansForNode = (node: ProseMirrorNode) => {
  let spans = spanCache.get(node)
  if (!spans) {
    // Leaf placeholders preserve PM offsets beside hard breaks and inline atoms.
    spans = getInlineMarkdownSpans(node.textBetween(0, node.content.size, '', '\ufffc'))
    spanCache.set(node, spans)
  }
  return spans
}

/** Absolute PM positions and untouched source, independent of decoration state. */
export const getInlineMarkdownLinkAtPosition = (state: EditorState, position = state.selection.from) => {
  const { doc } = state
  if (position < 0 || position > doc.content.size) return null
  const resolved = doc.resolve(position)
  if (!resolved.parent.isTextblock || resolved.parent.type.spec.code) return null
  const start = resolved.start()
  const span = spansForNode(resolved.parent).find(s => s.type === 'link' && s.from <= position - start && s.to >= position - start)
  if (!span) return null
  return {
    ...span, from: span.from + start, to: span.to + start,
    contentFrom: span.contentFrom + start, contentTo: span.contentTo + start,
    href: span.href ?? '',
    source: resolved.parent.textBetween(span.from, span.to, '', '\ufffc'),
    label: resolved.parent.textBetween(span.contentFrom, span.contentTo, '', '\ufffc'),
  }
}

export const isInlineMarkdownCodeAtPosition = (state: EditorState, position = state.selection.from): boolean => {
  const resolved = state.doc.resolve(Math.max(0, Math.min(position, state.doc.content.size)))
  if (resolved.parent.type.spec.code) return true
  if (!resolved.parent.isTextblock) return false
  const offset = position - resolved.start()
  const spans = spansForNode(resolved.parent)
  if (spans.some(s => s.type === 'inlineCode' && s.from < offset && s.to > offset)) return true
  // Incomplete backticks remain plain source but must not open a note picker.
  const source = resolved.parent.textBetween(0, offset, '', '\ufffc')
  const tokens = lex(source)
  return tokens.some(t => t.type === 'text' && /`/.test(t.raw))
}

type SourceEditor = Pick<Editor, 'state'> & { view: Pick<Editor['view'], 'dispatch'> }

/** One content transaction; never calls mark commands or reparses the document. */
export const toggleInlineMarkdownFormat = (editor: SourceEditor, type: InlineMarkdownFormat): boolean => {
  const { state } = editor
  const { selection } = state
  const tr = state.tr
  const ranges: { from: number; to: number; node: ProseMirrorNode; start: number }[] = []
  state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (!node.isTextblock) return
    if (!node.type.spec.code) ranges.push({ from: Math.max(selection.from, pos + 1), to: Math.min(selection.to, pos + 1 + node.content.size), node, start: pos + 1 })
    return false
  })
  if (!ranges.length) return false
  const delimiters = { bold: '**', italic: '*', strike: '~~', inlineCode: '`', highlight: '==' }
  let collapsedCursor: number | undefined
  for (const range of ranges.reverse()) {
    const enclosing = spansForNode(range.node).filter(s => s.type === type && s.from + range.start <= range.from && s.to + range.start >= range.to).pop()
    if (enclosing) {
      tr.delete(range.start + enclosing.contentTo, range.start + enclosing.to)
      tr.delete(range.start + enclosing.from, range.start + enclosing.contentFrom)
      continue
    }
    const text = state.doc.textBetween(range.from, range.to, '', '\ufffc')
    let delimiter = delimiters[type]
    let pad = ''
    if (type === 'inlineCode' && text) {
      const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
      delimiter = '`'.repeat(longest + 1)
      if (text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text))) pad = ' '
    }
    const opening = delimiter + pad
    const closing = pad + delimiter
    tr.insert(range.to, state.schema.text(closing))
    tr.insert(range.from, state.schema.text(opening))
    if (selection.empty) collapsedCursor = range.from + opening.length
  }
  if (collapsedCursor !== undefined) tr.setSelection(TextSelection.create(tr.doc, collapsedCursor))
  else {
    const from = tr.mapping.map(selection.from, 1)
    const to = tr.mapping.map(selection.to, -1)
    tr.setSelection(TextSelection.create(tr.doc, selection.anchor <= selection.head ? from : to, selection.anchor <= selection.head ? to : from))
  }
  tr.setStoredMarks([])
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

type InlineDisplayState = { focused: boolean; composing: boolean; dragging: boolean; decorations: DecorationSet }
export const inlineMarkdownKey = new PluginKey<InlineDisplayState>('loomaInlineMarkdown')

const decorate = (state: EditorState, focused: boolean) => {
  const decorations: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock || node.type.spec.code) return
    const tags: Record<InlineMarkdownSpan['type'], string> = { bold: 'strong', italic: 'em', strike: 's', highlight: 'mark', inlineCode: 'code', link: 'a', escape: 'span' }
    const spans = spansForNode(node)
    const activeSpans = focused ? spans.filter(span =>
      state.selection.from <= pos + 1 + span.to && state.selection.to >= pos + 1 + span.from) : []
    // One inline box per outer expanded source range: nested syntax must not
    // paint the translucent background twice. Keep this in the frozen set.
    const outerActiveSpans = activeSpans.filter(span => !activeSpans.some(outer =>
      outer !== span && outer.from <= span.from && outer.to >= span.to))
    if (outerActiveSpans.length) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'looma-inline-expanded-block' }, { inlineHighlightBlock: true }))
      for (const span of outerActiveSpans) {
        decorations.push(Decoration.inline(pos + 1 + span.from, pos + 1 + span.to,
          { class: 'looma-inline-expanded-source' }, { inlineHighlight: true }))
      }
    }
    for (const span of spans) {
      const from = pos + 1 + span.from
      const to = pos + 1 + span.to
      const contentFrom = pos + 1 + span.contentFrom
      const contentTo = pos + 1 + span.contentTo
      const active = activeSpans.some(outer => outer.from <= span.from && outer.to >= span.to)
      if (active) continue
      if (from < contentFrom) decorations.push(Decoration.inline(from, contentFrom, { class: 'looma-inline-syntax', style: 'display: none' }, { syntax: true }))
      if (contentTo < to) decorations.push(Decoration.inline(contentTo, to, { class: 'looma-inline-syntax', style: 'display: none' }, { syntax: true }))
      if (contentFrom < contentTo && span.type !== 'escape') {
        const attrs: Record<string, string> = { nodeName: tags[span.type] }
        if (span.type === 'link') {
          attrs['data-inline-markdown-link'] = 'true'
          // Never turn an unsafe source destination into an executable DOM URL.
          const compactHref = Array.from(span.href ?? '').filter(char => char.charCodeAt(0) > 32).join('')
          if (span.href && !/^(?:javascript|vbscript|data):/i.test(compactHref)) attrs.href = span.href
          if (span.title) attrs.title = span.title
          if (span.href && isInternalNoteHref(span.href)) {
            attrs.class = 'looma-note-ref'
            attrs['data-looma-note-ref'] = span.href
          } else if (/^https?:/i.test(span.href ?? '')) attrs.class = 'looma-external-link'
        }
        decorations.push(Decoration.inline(contentFrom, contentTo, attrs))
      }
    }
    return false
  })
  return DecorationSet.create(state.doc, decorations)
}

// Normalize only real document writes (HTML paste / third-party mark commands).
// Display/selection transactions must never create a document or history step.
const normalizedTextblocks = new WeakSet<ProseMirrorNode>()
const normalizeInlineMarks = (state: EditorState) => {
  const tr = state.tr
  const order = ['link', 'bold', 'italic', 'strike', 'highlight', 'code']
  const insertions: { pos: number; text: string }[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock || node.type.spec.code) return
    if (normalizedTextblocks.has(node)) return false
    const insertionCount = insertions.length
    let active: { mark: import('@tiptap/pm/model').Mark; close: string }[] = []
    const transition = (marks: import('@tiptap/pm/model').Mark[], at: number, text: string) => {
      let common = 0
      while (common < marks.length && common < active.length && marks[common].eq(active[common].mark)) common++
      let syntax = active.slice(common).reverse().map(item => item.close).join('')
      active = active.slice(0, common)
      for (const mark of marks.slice(common)) {
        const delimiters: Record<string, string> = { bold: '**', italic: '*', strike: '~~', highlight: '==', code: '`', link: '[' }
        let open = delimiters[mark.type.name]
        let close = open
        if (mark.type.name === 'link') {
          const href = String(mark.attrs.href ?? '').replace(/\\/g, '\\\\').replace(/[()\s<>]/g, c => encodeURIComponent(c).replace('(', '%28').replace(')', '%29'))
          const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''
          close = `](${href}${title})`
        } else if (mark.type.name === 'code') {
          open = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1)
          close = open
          if (text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text))) { open += ' '; close = ' ' + close }
        }
        syntax += open
        active.push({ mark, close })
      }
      if (syntax) insertions.push({ pos: at, text: syntax })
    }
    node.forEach((child, offset) => {
      const marks = child.isText ? child.marks.filter(mark => order.includes(mark.type.name)).sort((a, b) => order.indexOf(a.type.name) - order.indexOf(b.type.name)) : []
      transition(marks, pos + 1 + offset, child.text ?? '')
      for (const mark of marks) tr.removeMark(pos + 1 + offset, pos + 1 + offset + child.nodeSize, mark)
    })
    transition([], pos + 1 + node.content.size, '')
    if (insertions.length === insertionCount) normalizedTextblocks.add(node)
    return false
  })
  if (!insertions.length) return null
  for (const insertion of insertions.reverse()) tr.insert(insertion.pos, state.schema.text(insertion.text))
  return tr.setStoredMarks([])
}

export const createInlineMarkdownPlugin = () => new Plugin<InlineDisplayState>({
  key: inlineMarkdownKey,
  appendTransaction(transactions, _old, state) {
    return transactions.some(tr => tr.docChanged) ? normalizeInlineMarks(state) : null
  },
  state: {
    init: (_, state) => ({ focused: false, composing: false, dragging: false, decorations: decorate(state, false) }),
    apply(tr, previous, _old, state) {
      const meta = tr.getMeta(inlineMarkdownKey)
        ?? (tr.getMeta('focus') ? { focused: true } : tr.getMeta('blur') ? { focused: false } : undefined)
      const focused = meta?.focused ?? previous.focused
      const composing = meta?.composing ?? previous.composing
      const dragging = meta?.dragging ?? previous.dragging
      return {
        focused, composing, dragging,
        decorations: composing || dragging ? previous.decorations.map(tr.mapping, tr.doc)
          : tr.docChanged || tr.selectionSet || meta ? decorate(state, focused) : previous.decorations,
      }
    },
  },
  view(view) {
    const document = view.dom.ownerDocument
    const finishDrag = () => {
      if (!view.isDestroyed && inlineMarkdownKey.getState(view.state)?.dragging) {
        view.dispatch(view.state.tr.setMeta(inlineMarkdownKey, { dragging: false }))
      }
    }
    document.addEventListener('mouseup', finishDrag)
    document.addEventListener('pointercancel', finishDrag)
    return { destroy() {
      document.removeEventListener('mouseup', finishDrag)
      document.removeEventListener('pointercancel', finishDrag)
    } }
  },
  props: {
    decorations: state => inlineMarkdownKey.getState(state)?.decorations,
    handleKeyDown(view, event) {
      if (view.composing || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return false
      const { selection } = view.state
      if (!selection.empty && !event.shiftKey) return false
      const next = selection.head + (event.key === 'ArrowLeft' ? -1 : 1)
      const hidden = inlineMarkdownKey.getState(view.state)?.decorations.find(next, next).some(d => d.spec.syntax)
      if (!hidden) return false
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, event.shiftKey ? selection.anchor : next, next)).scrollIntoView())
      return true
    },
    handleDOMEvents: {
      mousedown(view, event) {
        if (event.button === 0) view.dispatch(view.state.tr.setMeta(inlineMarkdownKey, { dragging: true }))
        return false
      },
      focus(view) { view.dispatch(view.state.tr.setMeta(inlineMarkdownKey, { focused: true })); return false },
      blur(view) { view.dispatch(view.state.tr.setMeta(inlineMarkdownKey, { focused: false, dragging: false })); return false },
      compositionstart(view) { view.dispatch(view.state.tr.setMeta(inlineMarkdownKey, { composing: true })); return false },
      compositionend(view) {
        requestAnimationFrame(() => {
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(inlineMarkdownKey, { composing: false }))
        })
        return false
      },
    },
  },
})

// Consume the lexer queue, not lexInline(remainder)[0] for every token (O(n²)).
// Cache is only an optimization: interleaved managers reset on a source mismatch.
let sourceTokens: Token[] = []
let sourceTokenIndex = 0
let sourceRemaining = -1
let readingSourceTokens = false

// Reference definitions are consumed by marked's block parser. Resolve links
// while its active lexer still owns those definitions; only their spelling is
// normalized, so decorations and future reloads need no hidden definition map.
const resolvedInlineSource = (token: Token): string => {
  if (!('tokens' in token) || !token.tokens) return token.raw
  const originalChildren = token.tokens.map(child => child.raw).join('')
  const children = token.tokens.map(resolvedInlineSource).join('')
  if (token.type === 'link' && token.raw.startsWith('[')
    && token.raw.slice(originalChildren.length + 1, originalChildren.length + 3) !== '](') {
    const href = token.href.replace(/\\/g, '\\\\').replace(/[()\s<>]/g, c => encodeURIComponent(c).replace('(', '%28').replace(')', '%29'))
    const title = token.title ? ` "${token.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''
    return `[${children}](${href}${title})`
  }
  const at = token.raw.indexOf(originalChildren)
  return at < 0 ? token.raw : token.raw.slice(0, at) + children + token.raw.slice(at + originalChildren.length)
}

// MarkdownManager encodes text before looking up renderMarkdown, so a text
// renderer cannot opt out. Project source text into a serialization-only token
// at the document boundary instead. No schema nodes, marks or editor state are
// changed; every structural renderer (including code and images) stays in charge.
const sourceForSerialization = (node: JSONContent): JSONContent => {
  if (node.type === 'codeBlock') return node
  if (node.type === 'text' && !node.marks?.length) return { ...node, type: 'loomaInlineSource' }
  return node.content ? { ...node, content: node.content.map(sourceForSerialization) } : node
}

export const InlineMarkdown = Extension.create({
  name: 'loomaInlineMarkdown',
  addExtensions: () => [Extension.create({
    name: 'loomaInlineDocument',
    markdownTokenName: 'doc',
    priority: 1000,
    // A parse handler registers the alias in MarkdownManager's token registry;
    // doc itself is constructed by the manager, not emitted by marked.
    parseMarkdown: (token, helpers) => helpers.createNode('doc', {}, helpers.parseChildren(token.tokens ?? [])),
    renderMarkdown: (node, helpers) => helpers.renderChildren((node.content ?? []).map(sourceForSerialization), '\n\n'),
  })],
  renderMarkdown: node => node.text ?? '',
  addProseMirrorPlugins: () => [createInlineMarkdownPlugin()],
  markdownTokenName: 'loomaInlineSource',
  parseMarkdown: token => ({ type: 'text', text: token.text ?? token.raw }),
  markdownTokenizer: {
    name: 'loomaInlineSource',
    level: 'inline',
    start: () => 0,
    tokenize(src, _tokens, lexer) {
      if (readingSourceTokens) return undefined
      if (sourceRemaining !== src.length || !src.startsWith(sourceTokens[sourceTokenIndex]?.raw ?? '\u0000')) {
        // Use the supplied active lexer, not lexInline on a separate instance:
        // the latter has no document-level reference definitions. The guard
        // delegates this nested pass to marked's other inline tokenizers.
        readingSourceTokens = true
        try { sourceTokens = lexer.inlineTokens(src) as Token[] }
        finally { readingSourceTokens = false }
        sourceTokenIndex = 0
        sourceRemaining = src.length
      }
      const token = sourceTokens[sourceTokenIndex++]
      if (!token) return undefined
      sourceRemaining -= token.raw.length
      // Keep structural inline nodes and block parsing owned by Tiptap.
      if (['image', 'br', 'html'].includes(token.type)) return undefined
      return { type: 'loomaInlineSource', raw: token.raw, text: resolvedInlineSource(token) }
    },
  },
})
