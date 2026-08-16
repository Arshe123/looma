import { Fragment } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/vue-3'

export type MarkdownImageTarget = {
  alt: string
  src: string
  title?: string
  widthPercent?: number
}

export type ImageResizeDirection = 'right' | 'bottom' | 'bottomRight'

export const MIN_IMAGE_WIDTH_PERCENT = 10
export const MAX_IMAGE_WIDTH_PERCENT = 100

export const clampImageWidthPercent = (value: number) => Math.min(
  MAX_IMAGE_WIDTH_PERCENT,
  Math.max(MIN_IMAGE_WIDTH_PERCENT, Math.round(value)),
)

export const computeResizedImageWidthPercent = ({
  direction,
  startWidth,
  startHeight,
  containerWidth,
  deltaX,
  deltaY,
}: {
  direction: ImageResizeDirection
  startWidth: number
  startHeight: number
  containerWidth: number
  deltaX: number
  deltaY: number
}) => {
  if (startWidth <= 0 || startHeight <= 0 || containerWidth <= 0) return MAX_IMAGE_WIDTH_PERCENT
  const widthFromHorizontal = startWidth + deltaX
  const widthFromVertical = (startHeight + deltaY) * (startWidth / startHeight)
  const nextWidth = direction === 'right'
    ? widthFromHorizontal
    : direction === 'bottom'
      ? widthFromVertical
      : Math.abs(deltaX) >= Math.abs(deltaY * (startWidth / startHeight))
        ? widthFromHorizontal
        : widthFromVertical
  return clampImageWidthPercent((nextWidth / containerWidth) * 100)
}

export const MARKDOWN_IMAGE_TEMPLATE = '![]()'
export const MARKDOWN_IMAGE_CURSOR_OFFSET = 4

export const formatMarkdownImage = ({ alt, src, title, widthPercent }: MarkdownImageTarget) => {
  const titleSuffix = title ? ` "${title}"` : ''
  const width = typeof widthPercent === 'number'
    ? `{width=${clampImageWidthPercent(widthPercent)}%}`
    : ''
  return `![${alt}](${src}${titleSuffix})${width}`
}

export type ImportedImage = {
  relativePath: string
  fileName: string
}

export const insertImportedImagesAt = (
  editor: Editor,
  images: readonly ImportedImage[],
  insertAt: number,
) => {
  if (editor.isDestroyed || images.length === 0) return false
  const safePosition = Math.min(Math.max(insertAt, 0), editor.state.doc.content.size)
  const content = images.flatMap(image => [
    { type: 'image', attrs: { src: image.relativePath, alt: image.fileName } },
    { type: 'paragraph' },
  ])
  const inserted = editor.commands.insertContentAt(safePosition, content)
  if (inserted) editor.commands.focus()
  return inserted
}

export const parseMarkdownImageBlock = (text: string): MarkdownImageTarget | null => {
  const match = text.match(/^!\[([^\]]*)\]\((.+)\)(?:\{width=(\d{1,3})%\})?$/)
  if (!match) return null

  const destination = match[2].trim()
  const titleMatch = /^(.*)\s+(["'])([^"']*)\2$/.exec(destination)
  const src = (titleMatch?.[1] ?? destination).trim()
  if (!src) return null

  const widthPercent = match[3] ? Number(match[3]) : undefined
  if (widthPercent !== undefined && (
    widthPercent < MIN_IMAGE_WIDTH_PERCENT || widthPercent > MAX_IMAGE_WIDTH_PERCENT
  )) return null

  return {
    alt: match[1],
    src,
    ...(titleMatch ? { title: titleMatch[3] } : {}),
    ...(widthPercent === undefined ? {} : { widthPercent }),
  }
}

export const insertMarkdownImageTemplate = (editor: Editor) => {
  if (editor.isDestroyed) return false

  const insertFrom = editor.state.selection.from
  return editor
    .chain()
    .focus()
    .insertContent(MARKDOWN_IMAGE_TEMPLATE)
    .setTextSelection(insertFrom + MARKDOWN_IMAGE_CURSOR_OFFSET)
    .run()
}

export const renderCurrentMarkdownImage = (editor: Editor) => {
  if (editor.isDestroyed) return false

  const { $from, empty } = editor.state.selection
  if (!empty || $from.depth < 1 || $from.parent.type.name !== 'paragraph') return false

  const target = parseMarkdownImageBlock($from.parent.textContent)
  const imageType = editor.schema.nodes.image
  const paragraphType = editor.schema.nodes.paragraph
  if (!target || !imageType || !paragraphType) return false

  const blockFrom = $from.before($from.depth)
  const blockTo = $from.after($from.depth)
  const image = imageType.create({ src: target.src, alt: target.alt })
  const paragraph = paragraphType.create()
  const transaction = editor.state.tr.replaceWith(
    blockFrom,
    blockTo,
    Fragment.fromArray([image, paragraph]),
  )
  const paragraphCursor = blockFrom + image.nodeSize + 1
  transaction.setSelection(TextSelection.create(transaction.doc, paragraphCursor))
  editor.view.dispatch(transaction.scrollIntoView())
  editor.view.focus()
  return true
}
