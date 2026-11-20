import type { JSONContent } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { NodeSelection } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import {
  getDroppedFilePaths,
  isSupportedDroppedImagePath,
  type DroppedFileLike,
} from './external-file-drop'
import { formatMarkdownImage } from './tiptap-image-insertion'
import { normalizeNoteLinkHref } from './markdown-note-links'
import { getInlineMarkdownSpans, hasInlineMarkdownSource } from './tiptap-inline-markdown'

/** Complete only hidden syntax around fully selected visible inline content. */
export const getInlineMarkdownSourceRange = (source: string, from: number, to: number) => {
  const spans = getInlineMarkdownSpans(source)
  const hidden = spans.flatMap(span => [
    { from: span.from, to: span.contentFrom }, { from: span.contentTo, to: span.to },
  ]).filter(range => range.from < range.to).sort((a, b) => a.from - b.from)
  const merged: { from: number; to: number }[] = []
  for (const range of hidden) {
    const last = merged[merged.length - 1]
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to)
    else merged.push({ ...range })
  }
  const boundary = (position: number, side: 1 | -1) => {
    let low = 0, high = merged.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (merged[mid].from < position || side === 1 && merged[mid].from === position) low = mid + 1
      else high = mid
    }
    const range = merged[low - 1]
    return range && (side === 1 ? position < range.to : position <= range.to)
      ? side === 1 ? range.to : range.from : position
  }
  for (const span of spans) {
    const start = boundary(span.contentFrom, 1), end = boundary(span.contentTo, -1)
    if (start < end && from <= start && to >= end) {
      from = Math.min(from, span.from)
      to = Math.max(to, span.to)
    }
  }
  return { from, to }
}

const getSourceSelectionRange = (state: EditorState) => {
  let { from, to } = state.selection
  for (const position of [from, to]) {
    const resolved = state.doc.resolve(position)
    const node = resolved.parent
    if (!node.isTextblock || node.type.spec.code || node.content.size === 0) continue
    // Applied marks are serialized by the structural serializer, not inline syntax.
    if (node.marks.some(mark => mark.type.spec.code)
      || Array.from({ length: node.childCount }, (_, index) => node.child(index)).some(child => child.marks.some(mark => mark.type.spec.code))) continue
    const start = resolved.start()
    const range = getInlineMarkdownSourceRange(node.textBetween(0, node.content.size, '', '\ufffc'),
      Math.max(0, from - start), Math.min(node.content.size, to - start))
    from = Math.min(from, start + range.from)
    to = Math.max(to, start + range.to)
  }
  return { from, to }
}

type FileTransferLike = {
  types: ArrayLike<string>
  files: ArrayLike<DroppedFileLike>
}

export const captureTiptapFileTransfer = (transfer: FileTransferLike | null | undefined) => {
  if (!transfer || !Array.from(transfer.types).includes('Files')) return null
  return getDroppedFilePaths(transfer.files)
}

export const transferContainsClipboardImage = (
  transfer: Pick<FileTransferLike, 'types'> | null | undefined,
) => Boolean(transfer && Array.from(transfer.types).some(type =>
  /^image\//i.test(type) || /^(?:public\.)?(?:png|tiff?|jpe?g)$/i.test(type),
))

export const shouldReadClipboardImage = (transfer: FileTransferLike | null | undefined) => {
  if (!transfer) return false
  if (transferContainsClipboardImage(transfer)) return true
  return Array.from(transfer.types).includes('Files') && getDroppedFilePaths(transfer.files).length === 0
}

export const formatMarkdownLink = (label: string, href: string) => {
  const escapedLabel = label.replace(/([\\[\]])/g, '\\$1')
  return `[${escapedLabel}](${normalizeNoteLinkHref(href)})`
}

export const getTiptapSelectionDocument = (state: EditorState): JSONContent | null => {
  if (state.selection.empty) return null
  const { from, to } = getSourceSelectionRange(state)
  return {
    type: 'doc',
    content: state.doc.slice(from, to, true).content.toJSON() as JSONContent[],
  }
}

export const selectionHasMarkdownSource = (state: EditorState) => {
  if (state.selection.empty) return false
  const { from, to } = getSourceSelectionRange(state)
  if (hasInlineMarkdownSource(state.doc.textBetween(from, to, '\n', ''))) return true
  let hasMarkdownSyntax = false
  state.selection.content().content.descendants((node) => {
    if (node.isText) {
      if (node.marks.length > 0) hasMarkdownSyntax = true
      return !hasMarkdownSyntax
    }
    if (node.type.name !== 'paragraph') hasMarkdownSyntax = true
    return !hasMarkdownSyntax
  })
  return hasMarkdownSyntax
}

/** Project source-backed syntax out of a temporary document, never the editor.
 * Parse complete textblocks so selections inside a delimiter/link stay plain.
 */
export const getTiptapClipboardPlainText = (doc: ProseMirrorNode, from = 0, to = doc.content.size) => {
  const hidden: { from: number; to: number }[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return
    if (node.type.spec.code) return false
    const code: { from: number; to: number }[] = []
    node.forEach((child, offset) => {
      if (child.marks.some(mark => mark.type.spec.code)) code.push({ from: offset, to: offset + child.nodeSize })
    })
    for (const span of getInlineMarkdownSpans(node.textBetween(0, node.content.size, '', '\ufffc'))) {
      if (code.some(range => range.from < span.to && range.to > span.from)) continue
      hidden.push({ from: pos + 1 + span.from, to: pos + 1 + span.contentFrom },
        { from: pos + 1 + span.contentTo, to: pos + 1 + span.to })
    }
    return false
  })
  const projection = new Transform(doc)
  for (const range of hidden.sort((a, b) => b.from - a.from)) {
    if (range.from < range.to) projection.delete(projection.mapping.map(range.from, 1), projection.mapping.map(range.to, -1))
  }
  return projection.doc.textBetween(projection.mapping.map(from), projection.mapping.map(to), '\n', '')
}

export const getTiptapClipboardCopyText = (state: EditorState) => {
  const { selection } = state
  if (selection instanceof NodeSelection && selection.node.type.name === 'image') {
    return formatMarkdownImage({
      alt: typeof selection.node.attrs.alt === 'string' ? selection.node.attrs.alt : '',
      src: typeof selection.node.attrs.src === 'string' ? selection.node.attrs.src : '',
      title: typeof selection.node.attrs.title === 'string' ? selection.node.attrs.title : undefined,
      widthPercent: typeof selection.node.attrs.widthPercent === 'number'
        ? selection.node.attrs.widthPercent
        : undefined,
    })
  }
  if (selection.empty) return null
  return getTiptapClipboardPlainText(state.doc, selection.from, selection.to)
}

export const partitionClipboardImagePaths = (paths: readonly string[]) => {
  const supported: string[] = []
  const unsupported: string[] = []

  for (const filePath of new Set(paths)) {
    if (isSupportedDroppedImagePath(filePath)) supported.push(filePath)
    else unsupported.push(filePath)
  }

  return { supported, unsupported }
}
