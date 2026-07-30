import { Fragment } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/vue-3'

export type MarkdownImageTarget = {
  alt: string
  src: string
}

export const MARKDOWN_IMAGE_TEMPLATE = '![]()'
export const MARKDOWN_IMAGE_CURSOR_OFFSET = 4

export const formatMarkdownImage = ({ alt, src }: MarkdownImageTarget) =>
  `![${alt}](${src})`

export const parseMarkdownImageBlock = (text: string): MarkdownImageTarget | null => {
  const match = text.match(/^!\[([^\]]*)\]\((.+)\)$/)
  if (!match) return null

  const src = match[2].trim()
  if (!src) return null

  return {
    alt: match[1],
    src,
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
