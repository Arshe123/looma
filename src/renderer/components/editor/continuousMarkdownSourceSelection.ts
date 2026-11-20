import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { getInlineMarkdownSourceRange } from '../../../shared/utils/tiptap-clipboard'

/** Inspect boundary textblocks only; large selected interiors stay untouched. */
export function continuousMarkdownSourceRange(state: EditorState, from: number, to: number) {
  const tree = syntaxTree(state)
  for (const [position, side] of [[from, 1], [to, -1]] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(position, side); node; node = node.parent) {
      if (/^(FencedCode|CodeBlock|HTMLBlock)$/.test(node.name)) break
      if (!/^(Paragraph|(?:ATX|Setext)Heading[1-6])$/.test(node.name)) continue
      if (from <= node.from && to >= node.to) break
      const range = getInlineMarkdownSourceRange(state.doc.sliceString(node.from, node.to),
        Math.max(0, from - node.from), Math.min(node.to, to) - node.from)
      from = Math.min(from, node.from + range.from)
      to = Math.max(to, node.from + range.to)
      break
    }
  }
  return { from, to }
}
