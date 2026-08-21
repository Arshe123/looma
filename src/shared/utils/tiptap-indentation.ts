import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/vue-3'

export const EDITOR_INDENT = '    '

type SelectedTextBlock = {
  node: ProseMirrorNode
  contentStart: number
}

type IndentTarget = {
  start: number
  leadingIndent: string
}

const getSelectedTextBlocks = (state: EditorState): SelectedTextBlock[] => {
  const { from, to, empty, $from } = state.selection
  if (empty) {
    return $from.parent.isTextblock
      ? [{ node: $from.parent, contentStart: $from.start() }]
      : []
  }

  const blocks: SelectedTextBlock[] = []
  state.doc.nodesBetween(from, to, (node, position) => {
    if (!node.isTextblock) return true
    const contentStart = position + 1
    // 与 CodeMirror 一致：选区恰好结束在下一行行首时，不缩进下一行。
    if (to > contentStart || (node.content.size === 0 && from <= contentStart && to >= contentStart)) {
      blocks.push({ node, contentStart })
    }
    return false
  })
  return blocks
}

const getBlockLeadingIndent = (node: ProseMirrorNode) => {
  const firstChild = node.firstChild
  if (!firstChild?.isText) return ''
  return /^[\t ]*/.exec(firstChild.text || '')?.[0] || ''
}

const getCodeBlockIndentTargets = (
  state: EditorState,
  node: ProseMirrorNode,
  contentStart: number,
): IndentTarget[] => {
  const text = node.textContent
  const { from, to, empty } = state.selection
  const localFrom = Math.max(0, Math.min(text.length, from - contentStart))
  const localTo = Math.max(0, Math.min(text.length, to - contentStart))
  let lineStart = text.lastIndexOf('\n', Math.max(0, localFrom - 1)) + 1
  const targets: IndentTarget[] = []

  while (lineStart <= text.length) {
    // 与 CodeMirror 一致：非空选区恰好结束在下一行行首时，不处理下一行。
    if (!empty && lineStart >= localTo) break
    const lineEnd = text.indexOf('\n', lineStart)
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
    targets.push({
      start: contentStart + lineStart,
      leadingIndent: /^[\t ]*/.exec(line)?.[0] || '',
    })
    if (empty || lineEnd === -1) break
    lineStart = lineEnd + 1
  }

  return targets
}

const getIndentTargets = (state: EditorState) => getSelectedTextBlocks(state).flatMap(({ node, contentStart }) => {
  if (node.type.spec.code) return getCodeBlockIndentTargets(state, node, contentStart)
  return [{ start: contentStart, leadingIndent: getBlockLeadingIndent(node) }]
})

const countIndentColumns = (indent: string, tabSize = 4) => {
  let columns = 0
  for (const char of indent) {
    columns += char === '\t' ? tabSize - (columns % tabSize) : 1
  }
  return columns
}

const hasDeferredTabContext = (state: EditorState) => {
  const deferredNodeNames = new Set(['table', 'tableRow', 'tableHeader', 'tableCell', 'listItem', 'taskItem'])
  const endpoints = [state.selection.$from, state.selection.$to]
  return endpoints.some(position => {
    for (let depth = position.depth; depth >= 0; depth -= 1) {
      if (deferredNodeNames.has(position.node(depth).type.name)) return true
    }
    return false
  })
}

/**
 * 表格和列表已有 Tiptap 的结构化 Tab 快捷键，必须让扩展自行处理。
 */
export const shouldDeferRichTextTab = (editor: Editor) => hasDeferredTabContext(editor.state)

/**
 * 对当前文本块或选中的多个文本块增减一级缩进。
 * 缩进宽度与源码编辑器显式配置的四个空格一致。
 */
export const changeRichTextIndent = (editor: Editor, direction: 'more' | 'less') => {
  if (editor.isDestroyed) return false
  const targets = getIndentTargets(editor.state)
  if (targets.length === 0) return false

  const transaction = editor.state.tr
  // 从后往前修改，避免前面的 step 改变后续文本块的位置。
  for (const { start, leadingIndent } of targets.reverse()) {
    if (direction === 'more') {
      transaction.insertText(EDITOR_INDENT, start)
      continue
    }

    if (!leadingIndent) continue
    const remainingColumns = Math.max(0, countIndentColumns(leadingIndent) - EDITOR_INDENT.length)
    transaction.insertText(' '.repeat(remainingColumns), start, start + leadingIndent.length)
  }

  if (transaction.docChanged) editor.view.dispatch(transaction.setMeta('uiEvent', 'indent'))
  return true
}
