import { EditorState, type Extension, type Text } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { createMarkdownNoteRefTemplate } from '@/shared/utils/tiptap-note-ref-insertion'
import { buildNoteRefRelativePath, isInternalNoteHref } from '@/shared/utils/note-link-ref'
import { normalizeMarkdownNoteLinks, normalizeNoteLinkHref } from '@/shared/utils/markdown-note-links'
import type { InlineMarkdownSpan } from '@/shared/utils/tiptap-inline-markdown'
import type { MarkdownReferenceIndex } from '@/shared/utils/markdown-reference-index'
import { getContinuousInlineSpans } from './continuousMarkdownSyntax'

/** Feed the already bounded inline plan here, BEFORE viewport clipping. Positions
 * use the same coordinate space as spans. Host emits these runs INSTEAD of its
 * single link mark, retaining ordinary nested formatting and syntax replacements. */
export function getContinuousReferenceRuns(spans: readonly InlineMarkdownSpan[], clip?: { from: number; to: number }) {
  const runs: { from: number; to: number; attributes: Record<string, string> }[] = []
  for (const link of spans) {
    if (link.type !== 'link' || !link.href || /^(?:javascript|vbscript|data):/i.test(Array.from(link.href).filter(char => char.charCodeAt(0) > 32).join(''))) continue
    const attributes: Record<string, string> = { href: link.href, 'data-href': link.href, 'data-inline-markdown-link': 'true' }
    if (link.title) attributes.title = link.title
    if (isInternalNoteHref(link.href)) {
      attributes.class = 'looma-note-ref'
      attributes['data-looma-note-ref'] = link.href
    } else if (/^https?:/i.test(link.href)) attributes.class = 'looma-external-link'
    const nested = spans.filter(child => child !== link && child.from >= link.contentFrom && child.to <= link.contentTo)
    const boundaries = [...new Set([link.contentFrom, link.contentTo, ...nested.flatMap(child => [child.from, child.contentFrom, child.contentTo, child.to])])].sort((a, b) => a - b)
    let first = true
    for (let index = 1; index < boundaries.length; index++) {
      const from = boundaries[index - 1], to = boundaries[index]
      if (from === to || nested.some(child => from >= child.from && to <= child.contentFrom || from >= child.contentTo && to <= child.to)) continue
      const left = clip ? Math.max(from, clip.from) : from, right = clip ? Math.min(to, clip.to) : to
      if (left < right) runs.push({ from: left, to: right, attributes: first && left === from ? { ...attributes } : { ...attributes, 'data-inline-markdown-link-continuation': 'true' } })
      first = false
    }
  }
  return runs
}

/** Explicit quick-copy lookup, never a render/scroll hot path. Walk only the
 * enclosing syntax node, then read that one complete reference (not its line). */
export function getContinuousReferenceAtPosition(state: EditorState, position: number, references?: MarkdownReferenceIndex) {
  if (position < 0 || position > state.doc.length || !syntaxTreeAvailable(state, position)) return null
  for (let node = syntaxTree(state).resolveInner(position, -1); node; node = node.parent) {
    if (/^(InlineCode|FencedCode|CodeBlock|HTMLBlock|CommentBlock|Image)$/.test(node.name)) return null
    if (node.name !== 'Link') continue
    const spans = getContinuousInlineSpans(state.doc, syntaxTree(state), node.from, node.to, references,
      (from, to) => state.doc.sliceString(from, to))
    const link = spans.find(span => span.type === 'link' && span.from === node.from && span.to === node.to)
    if (!link?.href || !isInternalNoteHref(link.href)) return null
    const raw = state.doc.sliceString(link.from, link.to)
    const label = state.doc.sliceString(link.contentFrom, link.contentTo)
    const source = raw.slice(link.contentTo - link.from, link.contentTo - link.from + 2) === ']('
      ? normalizeMarkdownNoteLinks(raw)
      : `[${label}](${normalizeNoteLinkHref(link.href).replace(/[()\\]/g, '\\$&')}${link.title ? ` "${link.title.replace(/["\\]/g, '\\$&')}"` : ''})`
    return { ...link, href: link.href, label, source }
  }
  return null
}

/** Exactly two UTF-16 code units; never stringify a large line or rope. */
export function getContinuousReferenceTrigger(state: EditorState) {
  const selection = state.selection.main
  if (state.readOnly || state.selection.ranges.length !== 1 || !selection.empty || selection.head < 2
    || state.doc.sliceString(selection.head - 2, selection.head) !== '[['
    || !syntaxTreeAvailable(state, selection.head)) return null
  for (let node = syntaxTree(state).resolveInner(selection.head - 1, -1); node; node = node.parent) {
    if (/^(InlineCode|FencedCode|CodeBlock|HTMLBlock|CommentBlock|Image|Link)$/.test(node.name)) return null
  }
  return { from: selection.head - 2, to: selection.head }
}

export interface ContinuousReferenceRequest {
  readonly id: number
  readonly workspaceId: string
  readonly fromRelativePath: string
  readonly selectedText: string
}
export interface ContinuousReferencesOptions {
  /** Include activation, !sourceOnly, !isPartial and workspace availability. */
  enabled: () => boolean
  /** Supply canonical model revision as well as path: a prop/model update may
   * precede the EditorView transaction. Omission retains doc-object protection. */
  identity: () => { workspaceId: string | null; fromRelativePath: string; revision?: number }
  /** Always called outside CodeMirror update; safe to update a Vue shallowRef. */
  onPickerChange: (request: ContinuousReferenceRequest | null) => void
}
export interface ContinuousReferenceSelection { relativePath: string; href: string; label: string }
export type ContinuousReferencesController = ReturnType<typeof createContinuousMarkdownReferences>

/** Host owns the shared picker. This adapter never creates another editor/model. */
export function createContinuousMarkdownReferences(options: ContinuousReferencesOptions) {
  let view: EditorView | null = null
  let generation = 0
  let pending: { request: ContinuousReferenceRequest; doc: Text; anchor: number; revision?: number } | null = null
  const eligible = () => {
    const identity = options.identity()
    return !!view && !view.state.readOnly && options.enabled() && !!identity.workspaceId && !!identity.fromRelativePath
  }
  const valid = () => {
    const identity = options.identity()
    return eligible() && pending && pending.doc === view!.state.doc
      && pending.request.workspaceId === identity.workspaceId
      && pending.request.fromRelativePath === identity.fromRelativePath
      && pending.revision === identity.revision
  }
  const publish = (request: ContinuousReferenceRequest | null) => {
    const ticket = generation
    queueMicrotask(() => {
      if (ticket !== generation) return
      if (request && !valid()) { cancel(); return }
      options.onPickerChange(request)
    })
  }
  const cancel = (restoreFocus = false, request?: ContinuousReferenceRequest) => {
    if (request && pending?.request !== request) return false
    generation++
    pending = null
    publish(null)
    if (restoreFocus && eligible()) view!.focus()
    return true
  }
  const refresh = () => { if (pending && !valid()) cancel() }
  const open = (target: EditorView, trigger?: { from: number; to: number }) => {
    if (target !== view || !eligible() || pending || target.composing) return false
    const identity = options.identity()
    const selection = target.state.selection.main
    if (target.state.selection.ranges.length !== 1) return false
    const selectedText = selection.empty ? '' : target.state.doc.sliceString(selection.from, selection.to)
    const anchor = trigger?.from ?? selection.from
    // Same ordinary behavior: [[ is removed immediately; cancel leaves it removed.
    if (trigger) target.dispatch({ changes: { from: trigger.from, to: trigger.to, insert: '' }, selection: { anchor }, userEvent: 'input.note-reference' })
    const request: ContinuousReferenceRequest = Object.freeze({ id: ++generation, workspaceId: identity.workspaceId!, fromRelativePath: identity.fromRelativePath, selectedText })
    pending = { request, doc: target.state.doc, anchor, revision: options.identity().revision }
    publish(request)
    return true
  }
  const select = (request: ContinuousReferenceRequest, payload: ContinuousReferenceSelection) => {
    if (!valid() || pending!.request !== request || !payload.relativePath) return false
    const target = view!, anchor = pending!.anchor
    // Never trust a delayed payload href computed for another document.
    const href = buildNoteRefRelativePath(request.fromRelativePath, payload.relativePath)
    const template = createMarkdownNoteRefTemplate(href)
    const to = target.state.selection.main.to
    cancel()
    target.dispatch({ changes: { from: anchor, to, insert: template.text },
      selection: { anchor: anchor + template.labelCursorOffset }, userEvent: 'input.note-reference', scrollIntoView: true })
    target.focus()
    return true
  }
  const extension: Extension = ViewPlugin.fromClass(class {
    constructor(target: EditorView) { view = target }
    update(update: ViewUpdate) {
      refresh()
      if (pending && update.selectionSet) { cancel(); return }
      if (!update.docChanged || pending || update.view.composing || !eligible()
        || !update.transactions.some(transaction => transaction.isUserEvent('input') && !transaction.isUserEvent('input.paste'))) return
      const trigger = getContinuousReferenceTrigger(update.state)
      if (!trigger) return
      const ticket = generation, state = update.state
      // No nested dispatch or synchronous Vue render in ViewPlugin.update.
      queueMicrotask(() => {
        if (ticket === generation && view?.state === state) open(update.view, trigger)
      })
    }
    destroy() { cancel(); view = null }
  })
  return { extension, open, select, cancel, refresh }
}
