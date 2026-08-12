import { Fragment } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import { TextSelection } from '@tiptap/pm/state'
import { canSplit } from '@tiptap/pm/transform'
import type { Editor } from '@tiptap/vue-3'
import { getMarkRange } from '@tiptap/core'
import { isInternalNoteHref } from './note-link-ref'

export type MarkdownNoteRefTemplate = {
  text: string
  labelCursorOffset: number
  hrefCursorOffset: number
}

export type MarkdownNoteRefEnterOptions = {
  onEmptyLabel?: () => void
}

export type EditableNoteRef = {
  from: number
  to: number
  label: string
  href: string
}

export type ParsedMarkdownNoteRefSource =
  | { label: string; href: string }
  | { error: string }

type MarkdownNoteRefMatch = {
  from: number
  to: number
  label: string
  href: string
  labelEnd: number
  hrefFrom: number
  hrefEnd: number
}

export const createMarkdownNoteRefTemplate = (href: string): MarkdownNoteRefTemplate => {
  const text = `[](${href})`
  return {
    text,
    labelCursorOffset: 1,
    hrefCursorOffset: text.length - 1,
  }
}

export const parseMarkdownNoteRefSource = (source: string): ParsedMarkdownNoteRefSource => {
  const match = source.match(/^\[([^\]\n]*)\]\(([^)\n]+)\)$/)
  if (!match) return { error: '请输入完整的 Markdown 引用：[文字](路径)' }
  if (!match[1].trim()) return { error: '引用文字不能为空' }
  if (!isInternalNoteHref(match[2].trim())) return { error: '笔记路径必须指向 .md 或 .txt 文件' }
  return { label: match[1], href: match[2].trim() }
}

export const findNearbyNoteRef = (state: EditorState): EditableNoteRef | null => {
  if (!state.selection.empty) return null
  const linkType = state.schema.marks.link
  if (!linkType) return null
  const positions = [state.selection.from, state.selection.from - 1, state.selection.from + 1]
  for (const position of positions) {
    if (position < 0 || position > state.doc.content.size) continue
    const range = getMarkRange(state.doc.resolve(position), linkType)
    if (!range) continue
    const mark = state.doc.resolve(range.from).nodeAfter?.marks.find(item => item.type === linkType)
      || state.doc.resolve(range.to).nodeBefore?.marks.find(item => item.type === linkType)
    const href = String(mark?.attrs.href || '')
    if (!isInternalNoteHref(href)) continue
    return {
      from: range.from,
      to: range.to,
      label: state.doc.textBetween(range.from, range.to, '', ''),
      href,
    }
  }
  return null
}

export const applyMarkdownNoteRefSource = (
  editor: Editor,
  target: EditableNoteRef,
  source: string,
): { ok: true } | { ok: false; error: string } => {
  const parsed = parseMarkdownNoteRefSource(source)
  if ('error' in parsed) return { ok: false, error: parsed.error }
  const linkType = editor.schema.marks.link
  if (!linkType) return { ok: false, error: '编辑器链接功能不可用' }
  const currentRange = target.from <= editor.state.doc.content.size
    ? getMarkRange(editor.state.doc.resolve(target.from), linkType)
    : undefined
  if (!currentRange) return { ok: false, error: '原笔记引用已发生变化，请重新选择后编辑' }
  const linkText = editor.schema.text(parsed.label, [linkType.create({ href: parsed.href })])
  editor.view.dispatch(editor.state.tr.replaceWith(currentRange.from, currentRange.to, Fragment.from(linkText)))
  return { ok: true }
}

const findMarkdownNoteRefAtCursor = (text: string, cursorOffset: number): MarkdownNoteRefMatch | null => {
  const pattern = /\[([^\]\n]*)\]\(([^)\n]+)\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    const from = match.index
    const to = from + match[0].length
    if (cursorOffset < from + 1 || cursorOffset > to - 1) continue
    const labelEnd = from + 1 + match[1].length
    const hrefFrom = labelEnd + 2
    return {
      from,
      to,
      label: match[1],
      href: match[2],
      labelEnd,
      hrefFrom,
      hrefEnd: to - 1,
    }
  }
  return null
}

export const insertMarkdownNoteRefTemplate = (editor: Editor, href: string) => {
  if (editor.isDestroyed || !href) return false
  const insertFrom = editor.state.selection.from
  const template = createMarkdownNoteRefTemplate(href)
  return editor
    .chain()
    .focus()
    .insertContent(template.text)
    .setTextSelection(insertFrom + template.labelCursorOffset)
    .run()
}

export const handleMarkdownNoteRefEnter = (
  editor: Editor,
  options: MarkdownNoteRefEnterOptions = {},
) => {
  if (editor.isDestroyed) return false
  const { $from, empty } = editor.state.selection
  if (!empty || $from.depth < 1 || $from.parent.type.name !== 'paragraph') return false

  const cursorOffset = $from.parentOffset
  const target = findMarkdownNoteRefAtCursor($from.parent.textContent, cursorOffset)
  if (!target) return false

  const paragraphStart = $from.start($from.depth)
  if (!target.label.trim()) {
    editor.commands.setTextSelection(paragraphStart + target.from + 1)
    options.onEmptyLabel?.()
    return true
  }
  if (cursorOffset <= target.labelEnd) {
    editor.commands.setTextSelection(paragraphStart + target.hrefEnd)
    return true
  }
  if (cursorOffset < target.hrefFrom || cursorOffset > target.hrefEnd) return false

  const linkType = editor.schema.marks.link
  if (!linkType) return false
  const linkText = editor.schema.text(target.label, [linkType.create({ href: target.href })])
  const replaceFrom = paragraphStart + target.from
  const replaceTo = paragraphStart + target.to
  let transaction = editor.state.tr.replaceWith(replaceFrom, replaceTo, Fragment.from(linkText))
  const linkEnd = replaceFrom + linkText.nodeSize
  transaction = transaction.setSelection(TextSelection.create(transaction.doc, linkEnd))
  if (canSplit(transaction.doc, linkEnd)) transaction = transaction.split(linkEnd)
  editor.view.dispatch(transaction.scrollIntoView())
  editor.view.focus()
  return true
}
