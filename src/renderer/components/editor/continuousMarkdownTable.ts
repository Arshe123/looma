import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { ChangeSet, EditorSelection, EditorState, type ChangeSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { getContinuousBlockLine, type BlockSourceRange } from './continuousMarkdownBlocks'

type TableView = Pick<EditorView, 'state' | 'dispatch'>
export type ContinuousTableContext = {
  from: number
  to: number
  /** Data row index, including the header as zero (delimiter maps to zero). */
  row: number
  column: number
  columns: number
  header: boolean
  separator: boolean
  align: ('left' | 'center' | 'right')[]
  cells: BlockSourceRange[]
}

/** Cheap source-caret query: only the current line/header/delimiter are read. */
export function getContinuousTableContext(state: EditorState): ContinuousTableContext | null {
  const position = state.selection.main.head
  const line = state.doc.lineAt(position), tree = syntaxTree(state)
  const table = getContinuousBlockLine(state.doc, tree, line).table
  if (!table || position < table.from || position > table.to) return null
  let node: SyntaxNode | null = tree.resolveInner(table.from, 1)
  while (node && node.name !== 'Table') node = node.parent
  if (!node) return null
  const row = table.separator ? 0 : Math.max(0, line.number - state.doc.lineAt(table.from).number - 1)
  const cells = table.separator ? sourceRow(state, node.getChild('TableDelimiter')!).cells : table.cells
  const found = cells.findIndex(cell => position <= cell.to)
  const column = Math.max(0, Math.min(table.columns - 1, found < 0 ? table.columns - 1 : found))
  return { from: table.from, to: table.to, row, column, columns: table.columns,
    header: table.header, separator: table.separator, align: table.align, cells }
}

type SourceRow = BlockSourceRange & { text: string; prefix: string; cells: BlockSourceRange[] }

/** Preserve existing cell delimiters when rich-text edits end in a backslash. */
export const continuousTableInput = EditorState.transactionFilter.of(transaction => {
  const state = transaction.startState
  if (!transaction.docChanged || state.readOnly
    || (!transaction.isUserEvent('input') && !transaction.isUserEvent('delete'))) return transaction
  const padding = new Set<number>()
  transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    const line = state.doc.lineAt(from)
    if (to > line.to || inserted.lines > 1) return
    const table = getContinuousBlockLine(state.doc, syntaxTree(state), line).table
    const cell = table && !table.separator && table.cells.find(cell => from >= cell.from && to <= cell.to)
    if (!cell || state.sliceDoc(cell.to, Math.min(cell.to + 1, state.doc.length)) !== '|') return
    const pipe = transaction.changes.mapPos(cell.to, 1), next = transaction.newDoc
    const row = next.lineAt(pipe)
    if (row.to - row.from > 4096 || next.sliceString(pipe, pipe + 1) !== '|') return
    let start = pipe
    while (start > row.from && next.sliceString(start - 1, start) === '\\') start--
    if ((pipe - start) % 2) padding.add(pipe)
  })
  if (!padding.size) return transaction
  const changes = ChangeSet.of([...padding].sort((a, b) => a - b).map(from => ({ from, insert: ' ' })), transaction.newDoc.length)
  const selection = EditorSelection.create(transaction.newSelection.ranges.map(range => range.empty
    ? EditorSelection.cursor(changes.mapPos(range.head, -1), range.assoc, range.bidiLevel ?? undefined, range.goalColumn)
    : range.map(changes)), transaction.newSelection.mainIndex)
  // Same transaction/history entry; the caret stays before the syntax padding.
  return [transaction, { changes, selection, sequential: true }]
})

function sourceRow(state: EditorState, node: SyntaxNode): SourceRow {
  const text = state.sliceDoc(node.from, node.to)
  const pipes = node.name === 'TableDelimiter'
    ? [...text.matchAll(/\|/g)].map(match => ({ from: node.from + match.index!, to: node.from + match.index! + 1 }))
    : node.getChildren('TableDelimiter')
  let start = node.from
  const cells: BlockSourceRange[] = []
  for (const pipe of pipes) {
    if (pipe === pipes[0] && !state.sliceDoc(start, pipe.from).trim()) { start = pipe.to; continue }
    cells.push({ from: start, to: pipe.from })
    start = pipe.to
  }
  if (start < node.to && (state.sliceDoc(start, node.to).trim() || !pipes.length)) cells.push({ from: start, to: node.to })
  return { from: node.from, to: node.to, text, prefix: state.sliceDoc(state.doc.lineAt(node.from).from, node.from), cells }
}

function deletionNode(state: EditorState, position: number, side: -1 | 1 = 1): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, side)
  while (node && node.name !== 'TableHeader' && node.name !== 'TableRow' && node.name !== 'Table') node = node.parent
  return node
}

function cellContent(state: EditorState, cell: BlockSourceRange): BlockSourceRange {
  const text = state.sliceDoc(cell.from, cell.to)
  const from = cell.from + text.length - text.trimStart().length
  return { from, to: Math.max(from, cell.to - (text.length - text.trimEnd().length)) }
}

const tableGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function changesPipeEscape(state: EditorState, from: number, to: number, rowEnd: number): boolean {
  return state.sliceDoc(from, to) === '\\' && /^\\*\|/.test(state.sliceDoc(to, rowEnd))
}

function erasesImplicitCell(state: EditorState, row: SyntaxNode, cell: BlockSourceRange, from: number, to: number): boolean {
  const content = cellContent(state, cell)
  return (cell.from === row.from || cell.to === row.to) && from <= content.from && to >= content.to
}

function adjacentDeletionRow(node: SyntaxNode, backward: boolean): SyntaxNode | null {
  // Quote/list continuation marks can occur between table rows in the tree.
  let adjacent = backward ? node.prevSibling : node.nextSibling
  for (let i = 0; adjacent && i < 8; i++) {
    if (adjacent.name === 'TableHeader' || adjacent.name === 'TableRow') return adjacent
    adjacent = backward ? adjacent.prevSibling : adjacent.nextSibling
  }
  return null
}

/** Horizontal rich-text boundaries only; preserve native character/Shift movement. */
export function handleContinuousTableArrow(view: TableView, backward: boolean): boolean {
  const { state } = view, selection = state.selection.main
  if (!selection.empty || state.selection.ranges.length !== 1) return false
  const tree = syntaxTree(state), head = selection.head
  const move = (position: number, assoc: -1 | 1) => {
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(position, assoc)]), userEvent: 'select', scrollIntoView: true })
    return true
  }
  const enter = (cell: BlockSourceRange) => {
    const content = cellContent(state, cell)
    return move(backward ? content.to : content.from, backward || content.from === content.to ? -1 : 1)
  }
  let node = deletionNode(state, head)
  if (!node && head === state.doc.lineAt(head).to) node = deletionNode(state, head, -1)
  if (!node) {
    // Match ordinary text/table transitions without walking blank source lines.
    for (let block: SyntaxNode | null = tree.resolveInner(head, backward ? 1 : -1); block; block = block.parent) {
      if (block.name !== 'Paragraph' || head !== (backward ? block.from : block.to)) continue
      const table = backward ? block.prevSibling : block.nextSibling
      if (table?.name !== 'Table') return false
      if (backward) return table.prevSibling ? move(table.prevSibling.to, -1) : true
      const header = table.getChild('TableHeader')
      const cell = header && header.to - header.from <= 2048 && sourceRow(state, header).cells[0]
      return cell ? enter(cell) : true
    }
    return false
  }
  if (node.name === 'Table' || node.to - node.from > 4096) return false
  const row = sourceRow(state, node), index = row.cells.findIndex(cell => cell.from <= head && head <= cell.to)
  if (index < 0) return false
  const content = cellContent(state, row.cells[index])
  if (content.from !== content.to) {
    if (!backward && head < content.from) return move(content.from, 1)
    if (backward && head > content.to) return move(content.to, -1)
    if (backward ? head > content.from : head < content.to) return false
  }
  const cell = row.cells[index + (backward ? -1 : 1)]
  if (cell) return enter(cell)
  const adjacent = adjacentDeletionRow(node, backward)
  if (adjacent) {
    if (adjacent.to - adjacent.from > 4096) return true
    const cells = sourceRow(state, adjacent).cells
    const target = cells[backward ? cells.length - 1 : 0]
    return target ? enter(target) : true
  }
  const table = node.parent
  if (table?.name !== 'Table') return false
  const outside = backward ? table.prevSibling : table.nextSibling
  return outside ? move(backward ? outside.to : outside.from, backward ? -1 : 1) : true
}

/** Boundary-only rich-text command; the source-only host must bypass this. */
export function handleContinuousTableDelete(view: TableView, backward: boolean): boolean {
  const { state } = view
  // A linear selection crossing cells is deliberately consumed, not converted
  // to an ordinary editor's rectangular CellSelection. Inspect only endpoint
  // rows for safe content selections; the tree query never materializes rows.
  let touchesTable = false, unsafeSelection = false
  for (const range of state.selection.ranges) {
    if (range.empty) {
      if (state.selection.ranges.length > 1 && (deletionNode(state, range.head) || deletionNode(state, range.head, -1))) return true
      continue
    }
    let table = false
    syntaxTree(state).iterate({ from: range.from, to: range.to, enter(ref) {
      if (ref.name === 'Table') table = true
      if (table) return false
    } })
    if (!table) continue
    touchesTable = true
    const row = deletionNode(state, range.from)
    const cell = row && row.name !== 'Table' && row.to - row.from <= 4096
      ? sourceRow(state, row).cells.find(cell => {
        const content = cellContent(state, cell)
        return range.from >= content.from && range.to <= content.to
      }) : null
    if (!cell || /[\\|]/.test(state.sliceDoc(range.from, range.to))
      || erasesImplicitCell(state, row!, cell, range.from, range.to)) unsafeSelection = true
  }
  if (touchesTable) return state.readOnly || unsafeSelection || state.selection.ranges.length !== 1
  const selection = state.selection.main
  if (!selection.empty) return false
  let node = deletionNode(state, selection.head)
  const line = state.doc.lineAt(selection.head)
  if (!node && selection.head === line.to) node = deletionNode(state, selection.head, -1)
  if (!node) {
    // Deleting the newline immediately outside a table can join a source row
    // to prose. Protect that boundary without scanning the table or document.
    const adjacent = backward && selection.head === line.from && line.number > 1
      ? state.doc.line(line.number - 1)
      : !backward && selection.head === line.to && line.number < state.doc.lines
        ? state.doc.line(line.number + 1) : null
    return !!adjacent && !!deletionNode(state, backward ? adjacent.to : adjacent.from, backward ? -1 : 1)
  }
  if (state.readOnly || state.selection.ranges.length !== 1 || node.name === 'Table' || node.to - node.from > 4096) return true
  const row = sourceRow(state, node)
  const found = row.cells.findIndex(cell => selection.head <= cell.to)
  const column = found < 0 ? row.cells.length - 1 : found
  const cell = row.cells[column]
  if (!cell) return true
  const content = cellContent(state, cell)
  // Mouse clicks resolve to visible text, while a live typing caret can be
  // after newly inserted trailing spaces. Delete those as ordinary text.
  if (backward && content.from < content.to && selection.head > content.to && selection.head <= cell.to) return false
  const inside = backward
    ? selection.head > content.from && selection.head <= content.to
    : selection.head >= content.from && selection.head < content.to
  if (inside) {
    // Removing the escape before a literal pipe would create a new column.
    const at = backward ? selection.head - 1 : selection.head
    if (changesPipeEscape(state, at, at + 1, node.to)) return true
    const first = tableGraphemes.segment(state.sliceDoc(content.from, content.to))[Symbol.iterator]().next().value
    return !!first && first.segment.length === content.to - content.from
      && erasesImplicitCell(state, node, cell, content.from, content.to)
  }
  if (backward && column === 0 && node.name === 'TableHeader' && content.from === content.to) {
    const table = node.parent
    if (!table || table.name !== 'Table' || !syntaxTreeAvailable(state, Math.min(state.doc.length, table.to + 1))) return true
    // Only this explicit final Backspace inspects the table. Stream bounded
    // rows and stop at the first content byte; never materialize the document.
    for (let child = table.firstChild; child; child = child.nextSibling) {
      if (child.name !== 'TableHeader' && child.name !== 'TableRow') continue
      if (child.to - child.from > 4096 || !/^[|\t ]*$/.test(state.sliceDoc(child.from, child.to))) return true
    }
    let from = table.from, to = table.to
    const first = state.doc.lineAt(from), last = state.doc.lineAt(to)
    if (first.from === from && last.to === to) {
      const before = first.number > 1 ? state.doc.line(first.number - 1) : null
      const after = last.number < state.doc.lines ? state.doc.line(last.number + 1) : null
      // Remove the deleted block's separator, not a new empty paragraph.
      if (after && !after.text.trim() && (!before || !before.text.trim())) to = Math.min(state.doc.length, after.to + 1)
      else if (!after && before && !before.text.trim()) from = Math.max(0, before.from - 1)
    }
    view.dispatch({ changes: { from, to }, selection: { anchor: from },
      userEvent: 'delete.backward', scrollIntoView: true })
    return true
  }
  let target = content, targetCell = cell, targetRow = node
  const otherCell = backward ? column - 1 : column + 1
  // Ordinary Backspace at the start of a nonempty cell deletes that cell's
  // OWN last character. Empty cells move back; forward end moves ahead.
  if (content.from === content.to || (!backward && selection.head >= content.to)) {
    if (otherCell >= 0 && otherCell < row.cells.length) targetCell = row.cells[otherCell]
    else {
      const adjacent = adjacentDeletionRow(node, backward)
      if (!adjacent || adjacent.to - adjacent.from > 4096) return true
      const cells = sourceRow(state, adjacent).cells
      if (!cells.length) return true
      targetRow = adjacent
      targetCell = cells[backward ? cells.length - 1 : 0]
    }
    target = cellContent(state, targetCell)
  }
  const segments = tableGraphemes.segment(state.sliceDoc(target.from, target.to))
  let from = target.from, to = target.from
  if (backward) {
    for (const segment of segments) from = target.from + segment.index
    to = target.to
  } else {
    const first = segments[Symbol.iterator]().next().value
    if (first) to = from + first.segment.length
  }
  // Never expose a pipe by deleting its backslash as an explicit grapheme.
  if (changesPipeEscape(state, from, to, targetRow.to)
    || (from !== to && erasesImplicitCell(state, targetRow, targetCell, from, to))) return true
  view.dispatch({ changes: { from, to }, selection: EditorSelection.create([EditorSelection.cursor(from, -1)]),
    userEvent: backward ? 'delete.backward' : 'delete.forward', scrollIntoView: true })
  return true
}

/** Explicit commands alone inspect the rows of this one parsed table. */
function readTable(state: EditorState, context: ContinuousTableContext) {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(context.from, 1)
  while (node && node.name !== 'Table') node = node.parent
  if (!node) return null
  const rows: SourceRow[] = []
  let delimiter: SourceRow | null = null
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableDelimiter') delimiter = sourceRow(state, child)
    else if (child.name === 'TableHeader' || child.name === 'TableRow') rows.push(sourceRow(state, child))
  }
  if (!delimiter || !rows.length || rows.some(row => row.cells.length !== context.columns)
    || delimiter.cells.length !== context.columns) return null
  return { rows, delimiter }
}

function dispatchChanges(view: TableView, changes: ChangeSpec, action: string,
  move?: { source: BlockSourceRange; target: (set: ChangeSet) => number }) {
  const set = view.state.changes(changes)
  if (set.empty) return false
  const original = view.state.selection.main
  const selection = move && original.from >= move.source.from && original.to <= move.source.to
    ? EditorSelection.single(move.target(set) + original.anchor - move.source.from, move.target(set) + original.head - move.source.from)
    : view.state.selection.map(set)
  view.dispatch({ changes: set, selection, userEvent: `input.table.${action}`, scrollIntoView: true })
  return true
}
const blankRow = (columns: number) => `| ${Array(columns).fill('').join(' | ')} |`
// A one-cell body may contain no pipe at all, but a table header must have one.
const headerText = (row: SourceRow) => row.cells.length === 1 && row.cells[0].from === row.from && row.cells[0].to === row.to ? `|${row.text}|` : row.text

export function runContinuousTableCommand(view: TableView, action: string): boolean {
  const { state } = view
  if (state.readOnly || state.selection.ranges.length !== 1) return false
  const context = getContinuousTableContext(state)
  if (!context || state.selection.main.from < context.from || state.selection.main.to > context.to
    || !syntaxTreeAvailable(state, Math.min(state.doc.length, context.to + 1))) return false
  const table = readTable(state, context)
  if (!table) return false
  const { rows, delimiter } = table
  if (action === 'rowAfter') {
    const row = context.row === 0 ? delimiter : rows[context.row]
    return dispatchChanges(view, { from: row.to, insert: `\n${delimiter.prefix}${blankRow(context.columns)}` }, action)
  }
  if (action === 'rowBefore') {
    const row = rows[context.row]
    if (context.row === 0) {
      return dispatchChanges(view, [
        { from: row.from, to: row.to, insert: blankRow(context.columns) },
        { from: delimiter.to, insert: `\n${delimiter.prefix}${row.text}` },
      ], action, { source: row, target: set => set.mapPos(delimiter.to, -1) + 1 + delimiter.prefix.length })
    }
    return dispatchChanges(view, { from: row.from, insert: `${blankRow(context.columns)}\n${row.prefix}` }, action)
  }
  if (action === 'rowUp' || action === 'rowDown') {
    if (context.separator) return false
    const other = context.row + (action === 'rowUp' ? -1 : 1)
    if (other < 0 || other >= rows.length) return false
    const row = rows[context.row], target = rows[other]
    return dispatchChanges(view, [
      { from: row.from, to: row.to, insert: context.row === 0 ? headerText(target) : target.text },
      { from: target.from, to: target.to, insert: other === 0 ? headerText(row) : row.text },
    ], action, { source: row, target: set => set.mapPos(target.from, -1) + (other === 0 && headerText(row) !== row.text ? 1 : 0) })
  }
  if (action === 'deleteTable' || (action === 'deleteRow' && rows.length === 1)) {
    return dispatchChanges(view, { from: context.from, to: context.to, insert: '' }, action)
  }
  if (action === 'deleteRow') {
    const row = rows[context.row || 1]
    const changes: ChangeSpec[] = [{ from: state.doc.lineAt(row.from).from - 1, to: row.to, insert: '' }]
    if (context.row === 0) changes.push({ from: rows[0].from, to: rows[0].to, insert: headerText(row) })
    return dispatchChanges(view, changes, action)
  }
  const allRows = [...rows, delimiter]
  const column = context.column
  if (action === 'columnBefore' || action === 'columnAfter') {
    return dispatchChanges(view, allRows.map(row => {
      const cell = row.cells[column], before = action === 'columnBefore'
      const content = row === delimiter ? state.sliceDoc(cell.from, cell.to) : '  '
      const leading = before && column === 0 && cell.from === row.from ? '|' : ''
      const trailing = !before && column === context.columns - 1 && cell.to === row.to ? '|' : ''
      return { from: before ? cell.from : cell.to, insert: before ? `${leading}${content}|` : `|${content}${trailing}` }
    }), action)
  }
  if (action === 'columnLeft' || action === 'columnRight') {
    const other = column + (action === 'columnLeft' ? -1 : 1)
    if (other < 0 || other >= context.columns) return false
    const activeRow = context.separator ? delimiter : rows[context.row]
    const active = activeRow.cells[column], destination = activeRow.cells[other]
    const replacement = (row: SourceRow, cell: BlockSourceRange, content: string) => ({
      from: cell.from, to: cell.to,
      insert: content.trim() ? content : `${cell.from === row.from ? '|' : ''}${content}${cell.to === row.to ? '|' : ''}`,
    })
    return dispatchChanges(view, allRows.flatMap(row => {
      const a = row.cells[column], b = row.cells[other]
      return [replacement(row, a, state.sliceDoc(b.from, b.to)), replacement(row, b, state.sliceDoc(a.from, a.to))]
    }), action, { source: active, target: set => set.mapPos(destination.from, -1)
      + (destination.from === activeRow.from && !state.sliceDoc(active.from, active.to).trim() ? 1 : 0) })
  }
  if (action === 'deleteColumn') {
    if (context.columns === 1) return dispatchChanges(view, { from: context.from, to: context.to, insert: '' }, action)
    return dispatchChanges(view, allRows.flatMap(row => {
      const cell = row.cells[column], next = row.cells[column + 1]
      const deletion = next ? { from: cell.from, to: next.from, insert: '' }
        : { from: row.cells[column - 1].to, to: cell.to, insert: '' }
      const changes = [deletion]
      // Keep one-column delimiters and newly exposed empty edge cells explicit.
      const leading = row.cells[0].from === row.from && (context.columns === 2
        || (column === 0 && next && !state.sliceDoc(next.from, next.to).trim()))
      const previous = row.cells[column - 1]
      const trailing = row.cells.at(-1)!.to === row.to && (context.columns === 2
        || (column === context.columns - 1 && previous && !state.sliceDoc(previous.from, previous.to).trim()))
      if (leading) {
        if (deletion.from === row.from) deletion.insert = '|'
        else changes.push({ from: row.from, to: row.from, insert: '|' })
      }
      if (trailing) {
        if (deletion.to === row.to) deletion.insert += '|'
        else changes.push({ from: row.to, to: row.to, insert: '|' })
      }
      return changes
    }), action)
  }
  if (action === 'alignLeft' || action === 'alignCenter' || action === 'alignRight') {
    const cell = delimiter.cells[column], source = state.sliceDoc(cell.from, cell.to)
    const token = source.trim()
    if (!/^:?-+:?$/.test(token)) return false
    const dashes = token.replace(/:/g, '')
    const replacement = action === 'alignLeft' ? `:${dashes}` : action === 'alignCenter' ? `:${dashes}:` : `${dashes}:`
    if (token === replacement) return false
    const from = cell.from + source.indexOf(token)
    return dispatchChanges(view, { from, to: from + token.length, insert: replacement }, action)
  }
  return false
}
/** Rows includes the header. Dimensions are bounded before allocating source. */
export function insertContinuousTable(view: TableView, rows: number, columns: number): boolean {
  const { state } = view, selection = state.selection.main
  if (state.readOnly || state.selection.ranges.length !== 1 || !Number.isInteger(rows) || !Number.isInteger(columns)
    || rows < 1 || rows > 1000 || columns < 1 || columns > 100 || rows * columns > 10000) return false
  const line = state.doc.lineAt(selection.from)
  if (selection.to > line.to || !syntaxTreeAvailable(state, line.to)) return false
  const block = getContinuousBlockLine(state.doc, syntaxTree(state), line)
  if (block.literal || block.table) return false
  const prefix = /^(?:[\t ]*(?:>[\t ]?|(?:[-+*]|\d+[.)])[\t ]+|\[[ xX]\][\t ]+))*[\t ]*/.exec(line.text)![0]
  if (selection.from < line.from + prefix.length) return false
  const continuation = prefix.replace(/(?:[-+*]|\d+[.)])(?=[\t ])|\[[ xX]\]/g, marker => ' '.repeat(marker.length))
  const before = state.sliceDoc(line.from + prefix.length, selection.from)
  const after = state.sliceDoc(selection.to, line.to)
  const previous = line.number > 1 ? state.doc.line(line.number - 1).text : ''
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : ''
  const leading = before.length ? `\n${continuation}\n${continuation}` : previous.trim() ? `\n${continuation}` : ''
  const trailing = after.length ? `\n${continuation}\n${continuation}` : next.trim() ? `\n${continuation}` : ''
  const source = [blankRow(columns), `| ${Array(columns).fill('---').join(' | ')} |`, ...Array(rows - 1).fill(blankRow(columns))].join(`\n${continuation}`)
  view.dispatch({ changes: { from: selection.from, to: selection.to, insert: leading + source + trailing },
    selection: EditorSelection.cursor(selection.from + leading.length + 2), userEvent: 'input.table.insert', scrollIntoView: true })
  return true
}
