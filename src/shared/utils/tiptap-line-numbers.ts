import { Extension } from '@tiptap/core'
import type { Node as ProsemirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const LINE_NUMBERS_PLUGIN_KEY = new PluginKey<DecorationSet>('loomaLineNumbers')

export type LineNumberPosition = {
  pos: number
  line: number
}

type RectPosition = {
  top: number
  left: number
}

type RectSize = RectPosition & {
  width: number
  height: number
}

/** 将浮层中心精确放到固定行号栏中心，并换算到滚动容器的内容坐标。 */
export const getOverlayPositionAtLineNumber = ({
  lineNumberRect,
  containerRect,
  scrollTop,
  scrollLeft,
  overlaySize,
}: {
  lineNumberRect: RectSize
  containerRect: RectPosition
  scrollTop: number
  scrollLeft: number
  overlaySize: number
}) => ({
  top: lineNumberRect.top - containerRect.top + scrollTop
    + (lineNumberRect.height - overlaySize) / 2,
  left: lineNumberRect.left - containerRect.left + scrollLeft
    + (lineNumberRect.width - overlaySize) / 2,
})

const countNewlines = (text: string) => {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count += 1
  }
  return count
}

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList'])

/**
 * 计算每个行块在「序列化后的 markdown」中的起始行号（1 起），与源码行号对齐。
 *
 * 序列化格式（与 @tiptap/markdown 实测一致）：
 * - 顶层块/引用块之间用空行分隔（+2 换行）；列表项之间只换行（+1）；
 * - 列表项内：文本块之间空行，嵌套列表紧跟；
 * - 段落/标题 = 行内软换行(\n) + 硬换行(hardBreak) 各占一行；
 * - 代码块 = 开 fence + 内容行 + 关 fence（内容行 i 在 fence+1+i）；
 * - 表格 = 前导空行 + 表头 + 分隔行 + 数据行（共 行数+2 行，行号不渲染仅占位）；
 * - 图片/分隔线 = 一行。
 *
 * pos 为行块内容起始位置（文档坐标）：文本块取 `块起始 + 1`，叶子块（图片/分隔线）取块起始。
 */
export const computeLineNumberPositions = (doc: ProsemirrorNode): LineNumberPosition[] => {
  const positions: LineNumberPosition[] = []
  // 已消耗的换行数；下一个块的起始行 = nl + 1
  let nl = 0

  const countInlineNewlines = (node: ProsemirrorNode): number => {
    let n = 0
    node.descendants((child) => {
      if (child.isText) n += countNewlines(child.text || '')
      else if (child.type.name === 'hardBreak') n += 1
      return true
    })
    return n
  }

  const walk = (node: ProsemirrorNode, pos: number): void => {
    const typeName = node.type.name

    if (typeName === 'paragraph' || typeName === 'heading') {
      positions.push({ pos: pos + 1, line: nl + 1 })
      nl += countInlineNewlines(node)
      return
    }

    if (typeName === 'codeBlock') {
      const text = node.textContent || ''
      const lines = text.split('\n')
      let cursor = pos + 1
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) cursor += lines[i - 1].length + 1
        positions.push({ pos: cursor, line: nl + 2 + i })
      }
      nl += countNewlines(text) + 2
      return
    }

    if (typeName === 'image' || typeName === 'horizontalRule') {
      positions.push({ pos, line: nl + 1 })
      return
    }

    if (typeName === 'table') {
      let rows = 0
      node.forEach((child) => {
        if (child.type.name === 'tableRow') rows += 1
      })
      nl += rows + 2
      return
    }

    // 容器：doc / blockquote / bulletList / orderedList / taskList / listItem / taskItem
    const joinNewlinesBefore = (childType: string): number => {
      if (typeName === 'listItem' || typeName === 'taskItem') {
        return LIST_TYPES.has(childType) ? 1 : 2
      }
      return LIST_TYPES.has(typeName) ? 1 : 2
    }

    let first = true
    node.forEach((child, offset) => {
      if (!first) nl += joinNewlinesBefore(child.type.name)
      first = false
      walk(child, pos + 1 + offset)
    })
  }

  // doc 本身没有 opening token；以 -1 起步，顶层子节点 offset 才是实际节点坐标。
  // 若从 0 起步，所有 widget 会整体落后 1 个位置，叶子图片的行号会被插到图片后方。
  walk(doc, -1)
  return positions
}

const createLineNumberElement = (line: number, active: boolean): HTMLElement => {
  const span = document.createElement('span')
  span.className = active
    ? 'looma-line-number looma-line-number-active'
    : 'looma-line-number'
  span.setAttribute('data-line', String(line))
  span.setAttribute('aria-hidden', 'true')
  span.textContent = String(line)
  return span
}

const buildLineNumberDecorations = (state: EditorState): DecorationSet => {
  const { doc, selection } = state
  const positions = computeLineNumberPositions(doc)
  const activeLinePosition = positions.reduce<number | null>((active, item) =>
    item.pos <= selection.head ? item.pos : active, null)
  const decorations: Decoration[] = positions.map(({ pos, line }) => {
    const activeLine = pos === activeLinePosition
    const node = doc.nodeAt(pos)
    if (node?.type.name === 'image') {
      return Decoration.node(
        pos,
        pos + node.nodeSize,
        { class: 'looma-image-line-number-host' },
        {
          imageLineNumber: true,
          lineNumber: line,
          activeLine,
        },
      )
    }
    return Decoration.widget(pos, () => createLineNumberElement(line, activeLine), {
      side: -1,
      ignoreSelection: true,
      stopEvent: () => true,
      lineNumber: line,
      activeLine,
    })
  })

  const { $head } = selection
  if ($head.depth > 0 && $head.parent.isTextblock) {
    const from = $head.before($head.depth)
    decorations.push(Decoration.node(
      from,
      from + $head.parent.nodeSize,
      { class: 'looma-active-line' },
      { activeLineBlock: true },
    ))
  }

  return DecorationSet.create(doc, decorations)
}

export const createLineNumbersPlugin = (): Plugin<DecorationSet> =>
  new Plugin<DecorationSet>({
    key: LINE_NUMBERS_PLUGIN_KEY,
    state: {
      init: (_, state) => buildLineNumberDecorations(state),
      apply: (transaction, oldSet, _oldState, newState) => {
        if (!transaction.docChanged && !transaction.selectionSet) {
          return oldSet.map(transaction.mapping, transaction.doc)
        }
        return buildLineNumberDecorations(newState)
      },
    },
    props: {
      decorations(state) {
        return LINE_NUMBERS_PLUGIN_KEY.getState(state)
      },
    },
  })

export const LineNumbers = Extension.create({
  name: 'loomaLineNumbers',
  addProseMirrorPlugins() {
    return [createLineNumbersPlugin()]
  },
})
