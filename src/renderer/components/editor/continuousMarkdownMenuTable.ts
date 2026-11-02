import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { getContinuousTableContext } from './continuousMarkdownTable'
import { getContinuousBlockLine } from './continuousMarkdownBlocks'

/** Geometry path: dimensions come from indexed line numbers, never table text. */
export function continuousToolbarTableSize(state: EditorState) {
  const table = getContinuousTableContext(state)
  return table ? { rows: state.doc.lineAt(table.to).number - state.doc.lineAt(table.from).number, cols: table.columns } : null
}

/** Explicit resize only; reuse the engine's parsed cell ranges, never a second table model. */
export function resizeContinuousToolbarTable(view: Pick<EditorView, 'state' | 'dispatch'>, rows: number, cols: number): boolean {
  const { state } = view
  if (state.readOnly || state.selection.ranges.length !== 1 || !Number.isInteger(rows) || !Number.isInteger(cols)
    || rows < 1 || rows > 99 || cols < 1 || cols > 99) return false
  const table = getContinuousTableContext(state)
  if (!table || state.selection.main.from < table.from || state.selection.main.to > table.to
    || !syntaxTreeAvailable(state, Math.min(state.doc.length, table.to + 1))) return false
  const tree = syntaxTree(state), first = state.doc.lineAt(table.from), last = state.doc.lineAt(table.to)
  const output: string[] = []
  let node = tree.resolveInner(table.from, 1)
  while (node.parent && node.name !== 'Table') node = node.parent
  const delimiterNode = node.getChild('TableDelimiter')
  if (!delimiterNode) return false
  const delimiterCells = state.doc.sliceString(delimiterNode.from, delimiterNode.to).replace(/^\|/, '').replace(/\|$/, '').split('|')
  // rows excludes the delimiter. Existing rows/cells retain their exact inline source.
  for (let index = 0; index < rows + 1; index++) {
    const delimiter = index === 1
    const line = first.number + index <= last.number ? state.doc.line(first.number + index) : null
    const source = line ? getContinuousBlockLine(state.doc, tree, line).table : null
    if (line && !source) return false
    const values = Array.from({ length: cols }, (_, column) => {
      if (delimiter) return delimiterCells[column] ?? ' --- '
      const cell = source?.cells[column]
      return cell ? state.doc.sliceString(cell.from, cell.to) : '  '
    })
    // Prefix is the parsed table's container prefix, not the first cell padding.
    const containerPrefix = state.doc.sliceString(first.from, table.from)
    output.push((index ? containerPrefix : '') + '|' + values.join('|') + '|')
  }
  const insert = output.join('\n')
  if (insert === state.doc.sliceString(table.from, table.to)) return false
  view.dispatch({ changes: { from: table.from, to: table.to, insert },
    selection: { anchor: table.from + 2 }, userEvent: 'input.table.resize', scrollIntoView: true })
  return true
}
