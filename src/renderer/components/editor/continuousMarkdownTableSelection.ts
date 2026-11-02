import { syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type ChangeSpec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type DOMEventHandlers, type ViewUpdate } from '@codemirror/view'
import { getContinuousBlockLine, type BlockSourceRange } from './continuousMarkdownBlocks'
import './continuousMarkdownTableSelection.css'
import { getSchema, getTextBetween, getTextSerializersFromSchema } from '@tiptap/core'
import { DOMSerializer } from '@tiptap/pm/model'
import { CellSelection } from '@tiptap/pm/tables'
import StarterKit from '@tiptap/starter-kit'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import { MarkdownManager } from '@tiptap/markdown'
import { InlineMarkdown } from '../../../shared/utils/tiptap-inline-markdown'
import { ResizableMarkdownImage } from '../../../shared/utils/resizable-markdown-image'
import { continuousClipboardHtmlToMarkdown, type ContinuousClipboardPayload } from './continuousMarkdownClipboard'
import { serializeMarkdownAst } from '../../../shared/utils/markdown-rich-text'

const clipboardExtensions = [StarterKit, Table, TableRow, TableHeader, TableCell, InlineMarkdown, ResizableMarkdownImage]
let clipboardCodec: { schema: ReturnType<typeof getSchema>; manager: MarkdownManager } | undefined
function codec() {
  return clipboardCodec ??= { schema: getSchema(clipboardExtensions), manager: new MarkdownManager({ extensions: clipboardExtensions }) }
}

type TableView = Pick<EditorView, 'state' | 'dispatch'>
type CellAddress = { lineFrom: number; column: number }
export type ContinuousTableRectangle = {
  tableFrom: number
  tableTo: number
  anchor: CellAddress
  head: CellAddress
  /** One collapsed CM caret only; selected cells live in metadata, not ranges. */
  caret: number
}
export const setContinuousTableSelection = StateEffect.define<ContinuousTableRectangle | null>()
export const continuousTableSelectionState = StateField.define<ContinuousTableRectangle | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setContinuousTableSelection)) return effect.value
    // Foreign writes invalidate rather than silently selecting unrelated cells.
    if (transaction.docChanged) return null
    if (value && transaction.selection && (!transaction.newSelection.main.empty
      || transaction.newSelection.main.head !== value.caret)) return null
    return value
  },
})
export function getContinuousTableSelection(state: EditorState) {
  return state.field(continuousTableSelectionState, false) ?? null
}
function rowAt(state: EditorState, position: number) {
  if (position < 0 || position > state.doc.length) return null
  const line = state.doc.lineAt(position)
  const table = getContinuousBlockLine(state.doc, syntaxTree(state), line).table
  return table && !table.separator ? { line, table } : null
}
function content(state: EditorState, cell: BlockSourceRange) {
  const source = state.sliceDoc(cell.from, cell.to), trimmed = source.trim()
  const from = cell.from + source.length - source.trimStart().length
  return { from, to: trimmed ? cell.to - (source.length - source.trimEnd().length) : from, source: trimmed }
}
function rectangle(state: EditorState, anchorAt: number, anchorColumn: number, headAt: number, headColumn: number): ContinuousTableRectangle | null {
  const a = rowAt(state, anchorAt), h = rowAt(state, headAt)
  if (!a || !h || a.table.from !== h.table.from || a.table.to !== h.table.to
    || !Number.isInteger(anchorColumn) || !Number.isInteger(headColumn)
    || anchorColumn < 0 || headColumn < 0 || anchorColumn >= a.table.columns || headColumn >= h.table.columns
    || !a.table.cells[anchorColumn] || !h.table.cells[headColumn]) return null
  return { tableFrom: a.table.from, tableTo: a.table.to,
    anchor: { lineFrom: a.line.from, column: anchorColumn }, head: { lineFrom: h.line.from, column: headColumn },
    caret: content(state, h.table.cells[headColumn]).from }
}
export function selectContinuousTableRectangle(view: TableView, anchorAt: number, anchorColumn: number, headAt: number, headColumn: number) {
  const selected = rectangle(view.state, anchorAt, anchorColumn, headAt, headColumn)
  if (!selected) return false
  view.dispatch({ effects: setContinuousTableSelection.of(selected),
    selection: EditorSelection.create([EditorSelection.cursor(selected.caret, -1)]),
    annotations: Transaction.addToHistory.of(false), userEvent: 'select.pointer' })
  return true
}
function* selectedRows(state: EditorState, selected: ContinuousTableRectangle) {
  const start = state.doc.lineAt(Math.min(selected.anchor.lineFrom, selected.head.lineFrom)).number
  const end = state.doc.lineAt(Math.max(selected.anchor.lineFrom, selected.head.lineFrom)).number
  const left = Math.min(selected.anchor.column, selected.head.column), right = Math.max(selected.anchor.column, selected.head.column)
  const tree = syntaxTree(state)
  for (let index = start; index <= end; index++) {
    const line = state.doc.line(index), table = getContinuousBlockLine(state.doc, tree, line).table
    if (!table || table.from !== selected.tableFrom || table.to !== selected.tableTo) return
    if (table.separator) continue
    if (!table.cells[right]) return
    yield { line, table, cells: table.cells.slice(left, right + 1), left }
  }
}
/** Explicit copy is the only read path that materializes selected cell text. */
export function readContinuousTableSelection(state: EditorState) {
  const selected = getContinuousTableSelection(state)
  if (!selected) return null
  const rows: string[][] = [], headers: boolean[] = []
  for (const row of selectedRows(state, selected)) {
    rows.push(row.cells.map(cell => content(state, cell).source))
    headers.push(row.table.header)
  }
  return { rows, headers }
}
/** Ordinary custom copy uses only the CellSelection head cell, not its rectangle. */
export function continuousTableCopySource(state: EditorState): string | null {
  const selected = getContinuousTableSelection(state)
  if (!selected) return null
  const row = rowAt(state, selected.head.lineFrom), cell = row?.table.cells[selected.head.column]
  return cell ? content(state, cell).source : null
}
export function continuousTableSelectedText(state: EditorState): string | null {
  const source = continuousTableCopySource(state)
  if (source === null) return null
  const { schema, manager } = codec()
  return schema.nodeFromJSON(manager.parse(source.replace(/\\\|/g, '|'))).textContent
}
/** Native ordinary cut uses a rectangular HTML slice but linear min/max text ranges.
 * Build only the explicitly requested row band; no editor/view or whole-note parse. */
export function continuousTableCutPayload(state: EditorState, document: Document) {
  const selected = getContinuousTableSelection(state)
  if (!selected) return null
  const { schema, manager } = codec()
  const rows = [...selectedRows(state, selected)]
  if (!rows.length) return null
  const table = schema.nodes.table.create(null, rows.map(row => schema.nodes.tableRow.create(null,
    row.table.cells.map(cell => {
      const parsed = schema.nodeFromJSON(manager.parse(content(state, cell).source.replace(/\\\|/g, '|')))
      return schema.nodes[row.table.header ? 'tableHeader' : 'tableCell'].create(null, parsed.content)
    }))))
  const doc = schema.nodes.doc.create(null, table)
  const left = Math.min(selected.anchor.column, selected.head.column), right = Math.max(selected.anchor.column, selected.head.column)
  const addresses: number[][] = []
  let rowOffset = 1
  for (let row = 0; row < table.childCount; row++) {
    const node = table.child(row), positions: number[] = []
    let cellOffset = rowOffset + 1
    for (let col = 0; col < node.childCount; col++) { positions.push(cellOffset); cellOffset += node.child(col).nodeSize }
    addresses.push(positions); rowOffset += node.nodeSize
  }
  const selection = CellSelection.create(doc, addresses[0][left], addresses[addresses.length - 1][right])
  const from = Math.min(...selection.ranges.map(range => range.$from.pos)), to = Math.max(...selection.ranges.map(range => range.$to.pos))
  const text = getTextBetween(doc, { from, to }, { textSerializers: getTextSerializersFromSchema(schema) })
  const shell = document.createElement('table'), body = document.createElement('tbody')
  shell.setAttribute('data-pm-slice', '1 1 -2 []')
  const slice = selection.content()
  const fragment = slice.content.firstChild?.type.name === 'table' ? slice.content.firstChild.content : slice.content
  body.append(DOMSerializer.fromSchema(schema).serializeFragment(fragment, { document }))
  shell.append(body)
  // Match the ordinary source-copy serializer's slice, including its current
  // row-only fragment behavior; do not silently promote it to a full table.
  const source = serializeMarkdownAst({ getJSON: () => ({ type: 'doc', content: selection.content().content.toJSON() }), markdown: codec().manager })
  return { text, html: shell.outerHTML, source }
}
function escapedCellInput(text: string) {
  // A cell edit cannot create physical rows or structural delimiters.
  return text.replace(/\r\n?|\n/g, '<br>').replace(/(\\*)\|/g, (_match, slashes: string) => `${slashes}${slashes.length % 2 ? '' : '\\'}|`)
}
/** Ordinary CellSelection replacement clears all cells, inserts in HEAD cell. */
export function replaceContinuousTableSelection(view: TableView, text: string, keepSelection = false) {
  return writeRectangle(view, text, keepSelection)
}
/** Paste repeats/truncates a rectangular grid, anchored at its upper-left. */
export function pasteContinuousTableSelection(view: TableView, grid: readonly (readonly string[])[]) {
  if (!grid.length || grid.some(row => !row.length)) return false
  return writeRectangle(view, '', true, grid)
}
function writeRectangle(view: TableView, text: string, keepSelection: boolean, grid?: readonly (readonly string[])[]) {
  const { state } = view, selected = getContinuousTableSelection(state)
  if (!selected) return false
  if (state.readOnly) return true
  const changes: ChangeSpec[] = []
  let insertionAt = selected.caret, insertionLength = 0, headPrefix = 0
  let rowIndex = 0
  for (const row of selectedRows(state, selected)) {
    for (let index = 0; index < row.cells.length; index++) {
      const cell = row.cells[index], value = content(state, cell)
      const isHead = row.line.from === selected.head.lineFrom && row.left + index === selected.head.column
      const gridRow = grid?.[rowIndex % grid.length]
      let insert = gridRow ? escapedCellInput(gridRow[index % gridRow.length]) : isHead ? escapedCellInput(text) : ''
      if (isHead) { insertionAt = value.from; insertionLength = insert.length }
      // Empty implicit edge cells need explicit pipes to survive reparsing.
      const first = cell.from === row.table.cells[0].from && state.sliceDoc(row.line.from, cell.from).trim().replace(/^[>\s-]*/, '') === ''
      const last = cell.to === row.line.to
      if (!insert && first && state.sliceDoc(cell.from - 1, cell.from) !== '|') {
        changes.push({ from: cell.from, insert: '|' })
        if (isHead) headPrefix = 1
      }
      if (!insert && last) changes.push({ from: cell.to, insert: '|' })
      // Protect existing pipe from an odd terminal backslash in zero-padding cells.
      if (/\\$/.test(insert) && (insert.match(/\\+$/)![0].length % 2) && value.to === cell.to) insert += ' '
      changes.push({ from: value.from, to: value.to, insert })
    }
    rowIndex++
  }
  const set = state.changes(changes)
  const mapped = keepSelection ? {
    ...selected, tableFrom: set.mapPos(selected.tableFrom, -1), tableTo: set.mapPos(selected.tableTo, 1),
    anchor: { ...selected.anchor, lineFrom: set.mapPos(selected.anchor.lineFrom, -1) },
    head: { ...selected.head, lineFrom: set.mapPos(selected.head.lineFrom, -1) },
    caret: set.mapPos(insertionAt, -1) + headPrefix,
  } : null
  view.dispatch({ changes: set,
    effects: setContinuousTableSelection.of(mapped),
    selection: EditorSelection.create([EditorSelection.cursor(set.mapPos(insertionAt, -1) + headPrefix + (grid ? 0 : insertionLength), -1)]),
    userEvent: grid ? 'input.paste' : text ? 'input.type' : 'delete.selection' })
  return true
}

export function pasteContinuousTableClipboard(view: TableView, payload: ContinuousClipboardPayload, document: Document) {
  if (!getContinuousTableSelection(view.state) || payload.files) return false
  if (view.state.readOnly) return true
  const html = payload.html ?? '', template = document.createElement('template')
  template.innerHTML = html
  const table = template.content.querySelector('table')
  const grid = table ? Array.from(table.rows, row => Array.from(row.cells, cell => continuousClipboardHtmlToMarkdown(cell.innerHTML, document)))
    : [[html ? continuousClipboardHtmlToMarkdown(html, document) : payload.text ?? '']]
  return pasteContinuousTableSelection(view, grid)
}

export type ContinuousTableSelectionOptions = {
  /** Supply !sourceOnly; remove/reconfigure the extension on mode changes too. */
  enabled?: (view: EditorView) => boolean
  reportError?: (message: string, detail: string) => void
}
/** Highest precedence: claims rectangular clipboard/input only; leaves other selection alone. */
export function continuousTableSelection(options: ContinuousTableSelectionOptions = {}): Extension {
  const sessions = new WeakMap<EditorView, { cancelled: boolean }>()
  const enabled = (view: EditorView) => options.enabled?.(view) !== false
  const active = (view: EditorView) => enabled(view) && !!getContinuousTableSelection(view.state)
  const clear = (view: EditorView) => {
    if (getContinuousTableSelection(view.state)) view.dispatch({ effects: setContinuousTableSelection.of(null), annotations: Transaction.addToHistory.of(false) })
  }
  const hit = (view: EditorView, event: MouseEvent) => {
    const element = view.dom.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.looma-continuous-table-cell[data-table-column]')
    if (!element || !view.contentDOM.contains(element)) return null
    const at = view.posAtDOM(element), row = rowAt(view.state, at), column = Number(element.dataset.tableColumn)
    const cell = row?.table.cells[column]
    if (!row || !cell) return null
    const value = content(view.state, cell)
    const position = Math.max(value.source ? value.from : cell.from, Math.min(value.source ? value.to : cell.to, view.posAtCoords({ x: event.clientX, y: event.clientY }, false) ?? cell.from))
    return { at, row, column, position, assoc: position === cell.to ? -1 as const : 1 as const }
  }
  const paint = ViewPlugin.fromClass(class {
    disposed = false
    marked = new Set<HTMLElement>()
    frame = 0
    listeners: [string, EventListener][] = []
    owner: Window
    constructor(readonly view: EditorView) {
      this.owner = view.dom.ownerDocument.defaultView!
      this.owner.addEventListener('blur', this.cancel)
      view.dom.ownerDocument.addEventListener('pointercancel', this.cancel)
      // Capture only this extension's claimed gestures before host CM handlers.
      // Equal Prec.highest facets otherwise depend on appendConfig order.
      for (const [name, handler] of Object.entries(handlers)) {
        const listener: EventListener = event => {
          if (handler?.call(null, event, view)) {
            event.preventDefault()
            event.stopPropagation()
          }
        }
        this.listeners.push([name, listener])
        view.contentDOM.addEventListener(name, listener, true)
      }
    }
    cancel = () => {
      const session = sessions.get(this.view)
      if (session) session.cancelled = true
      clear(this.view)
    }
    update(update: ViewUpdate) {
      if (!enabled(update.view) && getContinuousTableSelection(update.state)) {
        queueMicrotask(() => { if (!this.disposed) clear(this.view) })
      }
      if (this.frame) this.owner.cancelAnimationFrame(this.frame)
      this.frame = this.owner.requestAnimationFrame(() => { this.frame = 0; this.draw() })
    }
    draw() {
      const selected = enabled(this.view) ? getContinuousTableSelection(this.view.state) : null
      const next = new Set<HTMLElement>()
      if (selected) {
        const top = Math.min(selected.anchor.lineFrom, selected.head.lineFrom), bottom = Math.max(selected.anchor.lineFrom, selected.head.lineFrom)
        const left = Math.min(selected.anchor.column, selected.head.column), right = Math.max(selected.anchor.column, selected.head.column)
        // Only mounted viewport DOM, never source rows or the entire table.
        for (const cell of this.view.contentDOM.querySelectorAll<HTMLElement>('.looma-continuous-table-cell[data-table-column]')) {
          const column = Number(cell.dataset.tableColumn)
          if (column < left || column > right) continue
          const at = this.view.posAtDOM(cell), row = rowAt(this.view.state, at)
          if (row && row.table.from === selected.tableFrom && row.line.from >= top && row.line.from <= bottom) next.add(cell)
        }
      }
      for (const cell of this.marked) if (!next.has(cell)) cell.classList.remove('selectedCell')
      for (const cell of next) cell.classList.add('selectedCell')
      this.marked = next
      this.view.contentDOM.classList.toggle('looma-table-rectangle-selection', !!selected)
    }
    destroy() {
      this.disposed = true
      const session = sessions.get(this.view)
      if (session) session.cancelled = true
      sessions.delete(this.view)
      if (this.frame) this.owner.cancelAnimationFrame(this.frame)
      this.owner.removeEventListener('blur', this.cancel)
      this.view.dom.ownerDocument.removeEventListener('pointercancel', this.cancel)
      for (const [name, listener] of this.listeners) this.view.contentDOM.removeEventListener(name, listener, true)
      for (const cell of this.marked) cell.classList.remove('selectedCell')
      this.view.contentDOM.classList.remove('looma-table-rectangle-selection')
    }
  })
  const mouse = EditorView.mouseSelectionStyle.of((view, event) => {
    if (!enabled(view) || event.button !== 0 || event.detail > 1 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null
    clear(view)
    const anchor = hit(view, event)
    if (!anchor) return null
    const session = { cancelled: false }
    sessions.set(view, session)
    const original = view.state.selection
    let crossed = false
    return {
      get(current, extend, multiple) {
        if (session.cancelled || !enabled(view)) return view.state.selection
        const target = hit(view, current)
        if (target && target.row.table.from === anchor.row.table.from
          && (target.row.line.from !== anchor.row.line.from || target.column !== anchor.column || crossed)) {
          crossed = true
          selectContinuousTableRectangle(view, anchor.at, anchor.column, target.at, target.column)
          return view.state.selection
        }
        if (crossed) return view.state.selection
        const head = target?.position ?? view.posAtCoords({ x: current.clientX, y: current.clientY }, false) ?? anchor.position
        const range = EditorSelection.range(extend ? original.main.anchor : anchor.position, head, undefined, undefined, target?.assoc)
        return multiple ? original.addRange(range) : EditorSelection.create([range])
      },
      update(update) { if (update.docChanged) session.cancelled = true },
    }
  })
  const clipboard = (event: ClipboardEvent, view: EditorView, cut: boolean) => {
    if (!active(view)) return false
    event.preventDefault()
    if (!cut && event.clipboardData) {
      event.clipboardData.setData('text/plain', continuousTableSelectedText(view.state) ?? '')
      return true
    }
    const data = continuousTableCutPayload(view.state, view.dom.ownerDocument)
    if (data && event.clipboardData) {
      event.clipboardData.setData('text/plain', data.text)
      event.clipboardData.setData('text/html', data.html)
      if (cut) replaceContinuousTableSelection(view, '', true)
    }
    return true
  }
  const handlers: DOMEventHandlers<null> = {
    mousedown(event, view) { if (!enabled(view)) return false; if (event.button === 0 && !hit(view, event)) clear(view); return false },
    blur(_event, view) { clear(view); return false },
    copy: (event, view) => clipboard(event, view, false),
    cut: (event, view) => clipboard(event, view, true),
    paste(event, view) {
      if (!active(view) || event.clipboardData?.files.length) return false
      event.preventDefault()
      if (event.clipboardData) {
        const data = event.clipboardData
        try { pasteContinuousTableClipboard(view, { html: data.getData('text/html'), text: data.getData('text/plain') }, view.dom.ownerDocument) }
        catch (error) { options.reportError?.('粘贴表格内容失败，原文已保留。', error instanceof Error ? error.message : String(error)) }
      }
      return true
    },
    beforeinput(event, view) {
      if (!active(view)) return false
      if (event.inputType.startsWith('delete')) { event.preventDefault(); return replaceContinuousTableSelection(view, '', true) }
      if (event.inputType.startsWith('insert') && event.data !== null) { event.preventDefault(); return replaceContinuousTableSelection(view, event.data) }
      return false
    },
    compositionstart(_event, view) {
      // Clear first so subsequent IME transactions edit the head cell, never a linear range.
      if (active(view)) replaceContinuousTableSelection(view, '')
      return false
    },
    keydown(event, view) {
      if (!active(view)) return false
      if (event.key === 'Escape') { clear(view); return true }
      if (event.key === 'Backspace' || event.key === 'Delete') return replaceContinuousTableSelection(view, '', true)
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && event.key.length === 1) return replaceContinuousTableSelection(view, event.key)
      if (event.key.startsWith('Arrow') || event.key === 'Tab') clear(view)
      return false
    },
  }
  return [continuousTableSelectionState, paint, Prec.highest(mouse)]
}
