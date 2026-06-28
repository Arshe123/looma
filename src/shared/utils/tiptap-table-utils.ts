import { Editor } from '@tiptap/core'
import { Table } from '@tiptap/extension-table'
import { Node as ProseMirrorNode, NodeType } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import {
  CellSelection,
  TableMap,
  findCell,
  findTable,
  isInTable,
  moveTableColumn,
  moveTableRow,
} from '@tiptap/pm/tables'

export const TABLE_PICKER_GRID_ROWS = 6
export const TABLE_PICKER_GRID_COLS = 10
export const MAX_TABLE_SIZE = 99

type TableMatrixCell = {
  text: string
  header: boolean
}

type TableContext = {
  table: {
    node: ProseMirrorNode
    pos: number
    start: number
  }
  map: TableMap
  row: number
  col: number
  cellPos: number
}

export const clampTableSize = (
  rows: number,
  cols: number,
  maxRows = MAX_TABLE_SIZE,
  maxCols = MAX_TABLE_SIZE,
) => ({
  rows: Math.min(Math.max(Math.trunc(rows) || 1, 1), maxRows),
  cols: Math.min(Math.max(Math.trunc(cols) || 1, 1), maxCols),
})

export const normalizeTableMatrix = (
  matrix: TableMatrixCell[][],
  rows: number,
  cols: number,
): TableMatrixCell[][] => {
  const size = clampTableSize(rows, cols)
  const firstRowHasHeaders = matrix[0]?.some(cell => cell.header) ?? true

  return Array.from({ length: size.rows }, (_, rowIndex) =>
    Array.from({ length: size.cols }, (_, colIndex) => {
      const existing = matrix[rowIndex]?.[colIndex]
      if (existing) return existing

      return {
        text: '',
        header: firstRowHasHeaders && rowIndex === 0,
      }
    }),
  )
}

const getCurrentTableContext = (editor: Editor): TableContext | null => {
  const { state } = editor
  if (!isInTable(state)) return null

  const selection = state.selection
  const $cell = selection instanceof CellSelection
    ? selection.$anchorCell
    : findCellPosition(selection.$from)
  if (!$cell) return null

  const table = findTable($cell)
  if (!table) return null

  const map = TableMap.get(table.node)
  const rect = findCell($cell)

  return {
    table,
    map,
    row: rect.top,
    col: rect.left,
    cellPos: $cell.pos,
  }
}

const findCellPosition = ($pos: any) => {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth)
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      return $pos.doc.resolve($pos.before(depth))
    }
  }

  return null
}

const selectCellAt = (editor: Editor, row: number, col: number) => {
  const context = getCurrentTableContext(editor)
  if (!context) return false

  const targetRow = Math.min(Math.max(row, 0), context.map.height - 1)
  const targetCol = Math.min(Math.max(col, 0), context.map.width - 1)
  const relativeCellPos = context.map.positionAt(targetRow, targetCol, context.table.node)
  const cellPos = context.table.start + relativeCellPos

  const transaction = editor.state.tr
    .setSelection(TextSelection.near(editor.state.doc.resolve(cellPos + 1), 1))
    .scrollIntoView()
  editor.view.dispatch(transaction)
  return true
}

export const goToCellBelow = (editor: Editor) => {
  const context = getCurrentTableContext(editor)
  if (!context) return false

  const nextRow = context.row + 1
  const targetCol = context.col

  if (nextRow >= context.map.height) {
    editor.commands.addRowAfter()
  }

  return selectCellAt(editor, nextRow, targetCol)
}

export const insertTableWithSize = (editor: Editor, rows: number, cols: number) => {
  const size = clampTableSize(rows, cols)
  return editor
    .chain()
    .focus()
    .insertTable({ rows: size.rows, cols: size.cols, withHeaderRow: true })
    .run()
}

const createEmptyCell = (type: NodeType) => {
  return type.createAndFill() ?? type.create()
}

export const resizeCurrentTable = (editor: Editor, rows: number, cols: number) => {
  const context = getCurrentTableContext(editor)
  if (!context) return false

  const size = clampTableSize(rows, cols)
  const schema = editor.state.schema
  const rowType = schema.nodes.tableRow
  const cellType = schema.nodes.tableCell
  const headerType = schema.nodes.tableHeader
  const firstRow = context.table.node.firstChild
  const hasHeaderRow = Boolean(firstRow?.childCount && Array.from({ length: firstRow.childCount }).every((_, index) =>
    firstRow.child(index).type.name === 'tableHeader',
  ))

  const rowNodes: ProseMirrorNode[] = []

  for (let rowIndex = 0; rowIndex < size.rows; rowIndex += 1) {
    const oldRow = rowIndex < context.table.node.childCount ? context.table.node.child(rowIndex) : null
    const cells: ProseMirrorNode[] = []

    for (let colIndex = 0; colIndex < size.cols; colIndex += 1) {
      const targetType = hasHeaderRow && rowIndex === 0 ? headerType : cellType
      const oldCell = oldRow && colIndex < oldRow.childCount ? oldRow.child(colIndex) : null

      if (oldCell) {
        cells.push(
          oldCell.type.name === targetType.name
            ? oldCell
            : targetType.create(oldCell.attrs, oldCell.content, oldCell.marks),
        )
      } else {
        cells.push(createEmptyCell(targetType))
      }
    }

    rowNodes.push(rowType.create(null, cells))
  }

  const nextTable = context.table.node.type.create(context.table.node.attrs, rowNodes)
  const targetRow = Math.min(context.row, size.rows - 1)
  const targetCol = Math.min(context.col, size.cols - 1)
  const nextMap = TableMap.get(nextTable)
  const nextCellPos = context.table.start + nextMap.positionAt(targetRow, targetCol, nextTable)

  const transaction = editor.state.tr
    .replaceWith(context.table.pos, context.table.pos + context.table.node.nodeSize, nextTable)

  transaction
    .setSelection(TextSelection.near(transaction.doc.resolve(nextCellPos + 1), 1))
    .scrollIntoView()

  editor.view.dispatch(transaction)
  return true
}

export const copyCurrentTable = (editor: Editor) => {
  const context = getCurrentTableContext(editor)
  if (!context) return false

  const insertAt = context.table.pos + context.table.node.nodeSize
  const transaction = editor.state.tr
    .insert(insertAt, context.table.node.copy(context.table.node.content))
    .scrollIntoView()
  editor.view.dispatch(transaction)
  return true
}

export const moveCurrentRow = (editor: Editor, direction: -1 | 1) => {
  const context = getCurrentTableContext(editor)
  if (!context) return false

  const to = context.row + direction
  if (to < 0 || to >= context.map.height) return false

  return moveTableRow({ from: context.row, to })(editor.state, transaction => editor.view.dispatch(transaction))
}

export const moveCurrentColumn = (editor: Editor, direction: -1 | 1) => {
  const context = getCurrentTableContext(editor)
  if (!context) return false

  const to = context.col + direction
  if (to < 0 || to >= context.map.width) return false

  return moveTableColumn({ from: context.col, to })(editor.state, transaction => editor.view.dispatch(transaction))
}

const findLastDeletableCellRange = (cellPos: number, cell: ProseMirrorNode) => {
  let range: { from: number; to: number } | null = null

  cell.descendants((node, pos) => {
    const absolutePos = cellPos + 1 + pos

    if (node.isText && node.text?.length) {
      range = {
        from: absolutePos + node.text.length - 1,
        to: absolutePos + node.text.length,
      }
      return
    }

    if (node.type.name === 'hardBreak') {
      range = {
        from: absolutePos,
        to: absolutePos + node.nodeSize,
      }
    }
  })

  return range
}

const deleteLastCellCharacter = (editor: Editor, cellPos: number) => {
  const cell = editor.state.doc.nodeAt(cellPos)
  if (!cell) return false

  const range = findLastDeletableCellRange(cellPos, cell)
  if (!range) return false

  const transaction = editor.state.tr
    .delete(range.from, range.to)

  transaction
    .setSelection(TextSelection.near(transaction.doc.resolve(range.from), -1))
    .scrollIntoView()
  editor.view.dispatch(transaction)
  return true
}

const isCellEmpty = (editor: Editor, cellPos: number) => {
  const cell = editor.state.doc.nodeAt(cellPos)
  if (!cell) return true
  return !findLastDeletableCellRange(cellPos, cell)
}

const isTableEmpty = (table: ProseMirrorNode) => {
  let hasContent = false

  table.descendants((node) => {
    if ((node.isText && Boolean(node.text?.length)) || node.type.name === 'hardBreak') {
      hasContent = true
      return false
    }
    return !hasContent
  })

  return !hasContent
}

const getCellPosAt = (context: TableContext, row: number, col: number) => {
  return context.table.start + context.map.positionAt(row, col, context.table.node)
}

const getPreviousCellPos = (context: TableContext) => {
  if (context.row === 0 && context.col === 0) return null

  const previousRow = context.col === 0 ? context.row - 1 : context.row
  const previousCol = context.col === 0 ? context.map.width - 1 : context.col - 1

  return getCellPosAt(context, previousRow, previousCol)
}

const selectionIsAtCellStart = (editor: Editor, cellPos: number) => {
  const cellStart = TextSelection.near(editor.state.doc.resolve(cellPos + 1), 1)
  return editor.state.selection.from <= cellStart.from
}

export const handleTableBackspace = (editor: Editor) => {
  const context = getCurrentTableContext(editor)
  if (!context) return false
  if (!editor.state.selection.empty) return false

  if (!isCellEmpty(editor, context.cellPos)) {
    if (selectionIsAtCellStart(editor, context.cellPos)) {
      return deleteLastCellCharacter(editor, context.cellPos)
    }
    return false
  }

  if (context.row === 0 && context.col === 0) {
    if (isTableEmpty(context.table.node)) {
      return editor.commands.deleteTable()
    }
    return true
  }

  const previousCellPos = getPreviousCellPos(context)
  if (previousCellPos === null) return true

  if (deleteLastCellCharacter(editor, previousCellPos)) return true

  const transaction = editor.state.tr
    .setSelection(TextSelection.near(editor.state.doc.resolve(previousCellPos + 1), 1))
    .scrollIntoView()
  editor.view.dispatch(transaction)
  return true
}

export const handleTableEnter = (editor: Editor, shiftKey = false) => {
  if (!isInTable(editor.state)) return false
  if (shiftKey) return editor.commands.setHardBreak()
  return goToCellBelow(editor)
}

export const EnhancedTable = Table.extend({
  addKeyboardShortcuts() {
    const parentShortcuts = this.parent?.() ?? {}

    return {
      ...parentShortcuts,
      Enter: () => handleTableEnter(this.editor, false),
      'Shift-Enter': () => handleTableEnter(this.editor, true),
      Backspace: (props) => handleTableBackspace(this.editor) || parentShortcuts.Backspace?.(props) || false,
    }
  },
})
