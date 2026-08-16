import type { JSONContent } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { NodeSelection } from '@tiptap/pm/state'
import {
  getDroppedFilePaths,
  isSupportedDroppedImagePath,
  type DroppedFileLike,
} from './external-file-drop'
import { formatMarkdownImage } from './tiptap-image-insertion'

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
  return `[${escapedLabel}](${href})`
}

export const getTiptapSelectionDocument = (state: EditorState): JSONContent | null => {
  if (state.selection.empty) return null
  return {
    type: 'doc',
    content: state.selection.content().content.toJSON() as JSONContent[],
  }
}

export const selectionHasMarkdownSource = (state: EditorState) => {
  if (state.selection.empty) return false
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
  return state.doc.textBetween(selection.from, selection.to, '\n', '')
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
