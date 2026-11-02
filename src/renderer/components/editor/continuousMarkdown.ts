import { EditorSelection, EditorState, StateEffect, StateField, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { NoteTitleMetadata } from '@/shared/utils/markdown-renderer'
import { getInlineMarkdownSpans, type InlineMarkdownSpan } from '@/shared/utils/tiptap-inline-markdown'
import { parseMarkdownImageBlock, type MarkdownImageTarget } from '@/shared/utils/tiptap-image-insertion'
import { noteStatsLabel } from '@/shared/utils/note-reading-time'
import { syntaxTree } from '@codemirror/language'
import type { Tree } from '@lezer/common'
import { getContinuousBlockLine } from './continuousMarkdownBlocks'
import { continuousTableInput } from './continuousMarkdownTable'
import { getContinuousInlineSpans, getContinuousEmptyInlineSource, type ContinuousInlineCache } from './continuousMarkdownSyntax'
import { getContinuousReferenceRuns } from './continuousMarkdownReferences'
import type { MarkdownReferenceIndex } from '@/shared/utils/markdown-reference-index'

export type ContinuousMarkdownOptions = {
  contextAt: (offset: number) => { fence: string; fenceLength: number }
  resolveImage: (source: string) => Promise<string | null>
  metadata: () => NoteTitleMetadata | null
  references?: () => MarkdownReferenceIndex
}

type SourceDocument = Pick<Text, 'length' | 'lineAt' | 'sliceString'>
type SourceRange = { from: number; to: number }
type PlanLine = { from: number; line: number; className: string; attributes?: Record<string, string> }
type PlanMark = SourceRange & { className: string; href?: string; attributes?: Record<string, string> }
type PlanReplacement = SourceRange & { kind?: 'bullet' | 'task' | 'rule'; checked?: boolean; text?: string }
type PlanImage = SourceRange & MarkdownImageTarget
const WINDOW = 2048
const CONTEXT = 256
const MAX_SCANNED = 32768
const styles: Record<InlineMarkdownSpan['type'], string> = {
  bold: 'bold', italic: 'italic', strike: 'strike', inlineCode: 'code', highlight: 'highlight', link: 'link', escape: '',
}
export const refreshContinuousMarkdown = StateEffect.define<null>()

/** Link lookup also works when its source is expanded and no anchor DOM exists. */
export function getContinuousMarkdownLinkAt(doc: SourceDocument, position: number, tree?: Tree, references?: MarkdownReferenceIndex) {
  if (tree) return getContinuousInlineSpans(doc, tree, position, position, references,
    (from, to) => doc.sliceString(from, to)).find(token => token.type === 'link' && token.from <= position && token.to >= position)
  const line = doc.lineAt(position)
  const base = Math.floor(position / WINDOW) * WINDOW
  const from = Math.max(line.from, base - CONTEXT)
  const to = Math.min(line.to, base + WINDOW + CONTEXT)
  return getInlineMarkdownSpans(doc.sliceString(from, to)).find(token => token.type === 'link'
    && from + token.from <= position && from + token.to >= position
    && !(token.from === 0 && from > line.from) && !(from + token.to === to && to < line.to))
}

const safeImageSource = (source: string) => {
  const value = source.trim()
  if (!value) return false
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) < 32) return false
  if (/^data:/i.test(value)) return /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/i.test(value)
  return !/^[a-z][a-z\d+.-]*:/i.test(value) || /^(?:https?:|file:)/i.test(value) || /^[a-z]:[\\/]/i.test(value)
}

/** Visible source only; expanding inline syntax never switches an entire block. */
export function buildContinuousMarkdownPlan(
  doc: SourceDocument,
  visibleRanges: readonly SourceRange[],
  options: Pick<ContinuousMarkdownOptions, 'contextAt' | 'metadata' | 'references'> & { tree?: Tree },
  selection?: SourceRange,
) {
  const windows: SourceRange[] = []
  const lines: PlanLine[] = []
  const marks: PlanMark[] = []
  const replacements: PlanReplacement[] = []
  const images: PlanImage[] = []
  let title: (NoteTitleMetadata & { at: number }) | null = null
  const metadata = options.metadata()
  const pendingInline = getContinuousEmptyInlineSource(doc, selection)
  const seen = new Set<number>()
  const seenLines = new Set<number>()
  const seenSpans = new Set<string>()
  const inlineCache: ContinuousInlineCache = new Map()
  let scanned = 0
  const read = (from: number, to: number) => {
    to = Math.min(to, from + MAX_SCANNED - scanned)
    scanned += to - from
    return doc.sliceString(from, to)
  }
  const readInline = (from: number, to: number) => {
    if (to - from > MAX_SCANNED - scanned) return null
    const parts = []
    for (let at = from; at < to; at += WINDOW) parts.push(read(at, Math.min(to, at + WINDOW)))
    return parts.join('')
  }
  const hide = (from: number, to: number, kind?: 'bullet') => {
    if (to <= from || replacements.some(range => from < range.to && to > range.from)) return
    replacements.push({ from, to, ...(kind ? { kind } : {}) })
  }
  for (const visible of visibleRanges) {
    for (let base = Math.floor(visible.from / WINDOW) * WINDOW; base <= visible.to && scanned < MAX_SCANNED; base += WINDOW) {
      if (seen.has(base)) continue
      seen.add(base)
      const from = Math.max(0, base - CONTEXT)
      const to = Math.min(doc.length, base + WINDOW + CONTEXT, from + MAX_SCANNED - scanned)
      if (to <= from) continue
      windows.push({ from, to })
      const source = read(from, to)
      let position = from
      while (position <= to) {
        const line = doc.lineAt(position)
        const end = Math.min(line.to, to)
        const prefix = line.from >= from ? source.slice(line.from - from, Math.min(line.to - from, line.from - from + 160))
          : read(line.from, Math.min(line.to, line.from + 160))
        const block = options.tree && options.tree.length >= line.to ? getContinuousBlockLine(doc, options.tree, line) : undefined
        if (pendingInline?.from === line.from && block) {
          block.literal = false; block.rule = false; block.heading = undefined; block.setextMarker = false
        }
        const isCode = block ? block.literal : !!options.contextAt(line.from).fence || /^(?: {4}| {0,3}\t| {0,3}(?:`{3,}|~{3,}))/.test(prefix)
        if (!seenLines.has(line.from)) {
          seenLines.add(line.from)
          let className = 'looma-continuous-line'
          const attributes: Record<string, string> = {}
          const heading = /^(#{1,6})[ \t]+/.exec(prefix)
          const quote = /^>[ \t]?/.exec(prefix)
          const list = /^([-+*]|\d+[.)])[ \t]+/.exec(prefix)
          if (block) {
            if (block.quoteDepth || block.listDepth) {
              className += (block.quoteDepth ? ' looma-continuous-quote' : '') + (block.listDepth ? ' looma-continuous-list' : '')
              attributes.style = `--quote-depth:${block.quoteDepth};--list-depth:${block.listDepth};padding-left:calc(${block.quoteDepth} * 1rem + ${block.listDepth} * 1.25rem) !important`
              attributes['data-quote-depth'] = String(block.quoteDepth)
              attributes['data-list-depth'] = String(block.listDepth)
            }
            for (const marker of block.markers) {
              if (block.listMarker?.from === marker.from && !block.task) replacements.push({ ...marker, kind: 'bullet', text: block.listMarker.text })
              else hide(marker.from, marker.to)
            }
            if (block.literal) className += block.html ? ' looma-continuous-html-source' : ' looma-continuous-code-block'
            else {
              if (block.heading) {
                className += ` looma-continuous-heading looma-continuous-h${block.heading.level}`
                if (block.setextMarker) className += ' looma-continuous-structural-line'
                if (block.heading.level === 1 && metadata?.line === doc.lineAt(block.heading.from).number - 1) title = { ...metadata, at: block.heading.titleAt }
              }
              if (block.task) replacements.push({ from: block.task.from, to: block.task.to, kind: 'task', checked: block.task.checked })
              if (block.rule) replacements.push({ from: Math.max(line.from, ...block.markers.map(marker => marker.to)), to: line.to, kind: 'rule' })
              if (block.table) {
                const table = block.table
                if (table.separator) { className += ' looma-continuous-structural-line looma-continuous-table-separator'; hide(line.from, line.to) }
                else {
                  className += ' looma-continuous-table-row' + (table.header ? ' looma-continuous-table-header' : '')
                  attributes['data-table-columns'] = String(table.columns)
                  // Keep syntax as editable text. Replacement widgets between
                  // CSS cells create anonymous columns and ambiguous DOM carets.
                  const syntax = (from: number, to: number) => {
                    if (from < to) marks.push({ from, to, className: 'looma-continuous-table-syntax' })
                  }
                  const leadingPipes = new Map(table.delimiters.map(delimiter => [delimiter.to, delimiter.from]))
                  const closingPipe = table.delimiters[table.delimiters.length - 1]
                  for (const delimiter of table.delimiters) syntax(delimiter.from, delimiter.to)
                  for (const [column, cell] of table.cells.entries()) {
                    const style = `text-align:${table.align[column] || 'left'}`
                    const text = cell.from >= from && cell.to <= to ? source.slice(cell.from - from, cell.to - from) : readInline(cell.from, cell.to)
                    // Hide Markdown cell padding, retaining canonical offsets.
                    const leading = text === null ? 0 : /^[\t ]*/.exec(text)![0].length
                    const trailing = text === null ? 0 : /[\t ]*$/.exec(text)![0].length
                    if (text !== null && leading < text.length) {
                      syntax(cell.from, cell.from + leading)
                      syntax(cell.to - trailing, cell.to)
                    }
                    // Each pipe belongs to the following cell; the last cell
                    // also owns the closing pipe. Thus even `||` has a native
                    // text range and no out-of-cell structural DOM is needed.
                    const start = leadingPipes.get(cell.from) ?? cell.from
                    const end = column === table.cells.length - 1 && closingPipe?.from === cell.to ? closingPipe.to : cell.to
                    if (start < end) marks.push({ from: start, to: end, className: 'looma-continuous-table-cell', attributes: { style, 'data-table-column': String(column) } })
                  }
                }
              }
            }
          } else if (isCode) className += ' looma-continuous-code-block'
          else if (heading) {
            className += ` looma-continuous-heading looma-continuous-h${heading[1].length}`
            hide(line.from, line.from + heading[0].length)
          } else if (quote) {
            className += ' looma-continuous-quote'
            hide(line.from, line.from + quote[0].length)
          } else if (list) {
            className += ' looma-continuous-list'
            // Ordered numbers are meaningful source text, not a decorative bullet.
            if (/^[-+*]$/.test(list[1])) hide(line.from, line.from + list[0].length, 'bullet')
          }
          lines.push({ from: line.from, line: line.number, className, ...(Object.keys(attributes).length ? { attributes } : {}) })
          if (pendingInline?.from === line.from) marks.push({ ...pendingInline, className: 'looma-continuous-expanded-source' })
          if (!block && heading?.[1].length === 1 && !isCode && metadata?.line === line.number - 1) title = { ...metadata, at: line.to }
        }
        const fragment = source.slice(position - from, end - from)
        const tokens = isCode ? [] : options.tree
          ? getContinuousInlineSpans(doc, options.tree, position, end, options.references?.(), readInline, inlineCache).map(token => ({ ...token,
            from: token.from - position, to: token.to - position, contentFrom: token.contentFrom - position, contentTo: token.contentTo - position }))
          : getInlineMarkdownSpans(fragment)
        const expanded = selection ? tokens.filter(token =>
          selection.from <= position + token.to && selection.to >= position + token.from
          && (options.tree || (!(token.from === 0 && position > line.from) && !(position + token.to === end && end < line.to)))) : []
        const outerExpanded = expanded.filter(token => !expanded.some(outer =>
          outer !== token && outer.from <= token.from && outer.to >= token.to))
        if (!isCode) {
          for (const match of fragment.matchAll(/!\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)(?:\{width=\d{1,3}%\})?/g)) {
            const image = parseMarkdownImageBlock(match[0])
            const start = position + match.index!, finish = start + match[0].length
            const key = `image:${start}:${finish}`
            if (!image || !safeImageSource(image.src) || seenSpans.has(key)) continue
            if (tokens.some(token => token.type === 'inlineCode' && token.from <= match.index! && token.to >= match.index! + match[0].length)) continue
            seenSpans.add(key)
            images.push({ ...image, from: start, to: finish })
          }
        }
        const linkRuns = getContinuousReferenceRuns(tokens, { from: line.from - position, to: line.to - position })
        for (const token of tokens) {
          const start = position + token.from
          const finish = position + token.to
          const key = `${start}:${finish}:${token.type}${options.tree ? ':' + line.from : ''}`
          if (seenSpans.has(key) || (!options.tree && ((token.from === 0 && position > line.from) || (finish === end && end < line.to)))) continue
          if (images.some(image => start < image.to && finish > image.from)) continue
          seenSpans.add(key)
          if (expanded.some(outer => outer.from <= token.from && outer.to >= token.to)) {
            if (outerExpanded.includes(token)) {
              const from = Math.max(line.from, start), to = Math.min(line.to, finish)
              if (from < to) marks.push({ from, to, className: 'looma-continuous-expanded-source' })
            }
            continue
          }
          const contentFrom = Math.max(line.from, position + token.contentFrom)
          const contentTo = Math.min(line.to, position + token.contentTo)
          if (token.type === 'link') {
            for (const run of linkRuns) {
              if (run.from < token.contentFrom || run.to > token.contentTo) continue
              const { class: classification, ...attributes } = run.attributes
              marks.push({ from: position + run.from, to: position + run.to, className: `looma-continuous-link${classification ? ' ' + classification : ''}`, href: token.href, attributes })
            }
          } else if (contentFrom < contentTo && styles[token.type]) marks.push({ from: contentFrom, to: contentTo, className: `looma-continuous-${styles[token.type]}` })
          hide(Math.max(line.from, start), Math.min(line.to, position + token.contentFrom))
          hide(Math.max(line.from, position + token.contentTo), Math.min(line.to, finish))
        }
        if (line.to >= to || line.to === doc.length) break
        position = line.to + 1
      }
    }
  }
  return { windows, scanned, lines, marks, replacements, images, title }
}

class BulletWidget extends WidgetType {
  constructor(readonly text = '•') { super() }
  eq(other: BulletWidget) { return other.text === this.text }
  toDOM() {
    const element = document.createElement('span')
    element.className = 'looma-continuous-bullet'
    element.textContent = /^\d/.test(this.text) ? this.text : '•'
    return element
  }
  ignoreEvent() { return false }
}
class TaskWidget extends WidgetType {
  constructor(readonly from: number, readonly checked: boolean, readonly readOnly: boolean) { super() }
  eq(other: TaskWidget) { return this.from === other.from && this.checked === other.checked && this.readOnly === other.readOnly }
  toDOM(view: EditorView) {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'looma-continuous-task'
    input.checked = this.checked
    input.disabled = this.readOnly
    input.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为已完成')
    input.addEventListener('mousedown', event => event.preventDefault())
    input.addEventListener('change', () => {
      if (view.state.readOnly || !/^\[[ xX]\]$/.test(view.state.doc.sliceString(this.from, this.from + 3))) return
      view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: input.checked ? 'x' : ' ' } })
    })
    return input
  }
  ignoreEvent() { return true }
}
class StructuralWidget extends WidgetType {
  eq() { return true }
  toDOM() {
    const element = document.createElement('span')
    element.className = 'looma-continuous-rule'
    element.setAttribute('role', 'separator')
    return element
  }
  ignoreEvent() { return false }
}
class ReadingTimeWidget extends WidgetType {
  constructor(readonly minutes: number | null, readonly words: number | null) { super() }
  eq(other: ReadingTimeWidget) { return this.minutes === other.minutes && this.words === other.words }
  toDOM() {
    const element = document.createElement('span')
    element.className = 'looma-note-reading-time'
    element.textContent = noteStatsLabel(this.minutes, this.words)
    return element
  }
}
class ImageWidget extends WidgetType {
  private mounted = new WeakSet<HTMLElement>()
  constructor(readonly image: MarkdownImageTarget, readonly resolve: ContinuousMarkdownOptions['resolveImage']) { super() }
  eq(other: ImageWidget) { return this.resolve === other.resolve && JSON.stringify(this.image) === JSON.stringify(other.image) }
  toDOM(view: EditorView) {
    const wrapper = document.createElement('span')
    wrapper.className = 'looma-continuous-image'
    if (this.image.widthPercent) wrapper.style.width = `${this.image.widthPercent}%`
    const image = document.createElement('img')
    image.alt = this.image.alt
    if (this.image.title) image.title = this.image.title
    image.draggable = false
    wrapper.appendChild(image)
    this.mounted.add(wrapper)
    void this.resolve(this.image.src).then(source => {
      if (!this.mounted.has(wrapper)) return
      if (source && safeImageSource(source)) {
        image.onload = () => { if (this.mounted.has(wrapper)) view.requestMeasure() }
        image.onerror = () => {
          if (!this.mounted.has(wrapper)) return
          wrapper.textContent = `无法加载图片：${this.image.alt || this.image.src}`
          view.requestMeasure()
        }
        image.src = source
      } else { wrapper.textContent = `无法加载图片：${this.image.alt || this.image.src}` }
      view.requestMeasure()
    }).catch(() => { if (this.mounted.has(wrapper)) wrapper.textContent = '无法加载图片' })
    return wrapper
  }
  destroy(dom: HTMLElement) { this.mounted.delete(dom) }
}

/** Padding and zero-width syntax may hit the next source delimiter. Resolve
 *  against the actual cell box, without taking over native drag handling. */
function tablePointerPosition(view: EditorView, event: MouseEvent) {
  const element = view.dom.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.looma-continuous-table-cell')
  if (!element || !view.contentDOM.contains(element)) return null
  const position = view.posAtDOM(element)
  const table = getContinuousBlockLine(view.state.doc, syntaxTree(view.state), view.state.doc.lineAt(position)).table
  const cell = table?.cells[Number(element.dataset.tableColumn)]
  if (!cell) return null
  const at = view.posAtCoords({ x: event.clientX, y: event.clientY }, false) ?? cell.from
  const text = view.state.doc.sliceString(cell.from, cell.to)
  const start = text.trim() ? cell.from + text.length - text.trimStart().length : cell.from
  const end = text.trim() ? cell.to - (text.length - text.trimEnd().length) : cell.to
  const positionInCell = Math.max(start, Math.min(end, at))
  // A zero-length cell ends where the next cell's leading pipe starts. Bias
  // the native DOM caret towards its own source, not the neighbour's box.
  return { position: positionInCell, assoc: positionInCell === cell.to ? -1 : 1 }
}

const tableMouseSelection = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.detail > 1 || event.ctrlKey || event.metaKey || event.altKey) return null
  const position = tablePointerPosition(view, event)
  if (position === null) return null
  let anchor = position.position, original = view.state.selection
  return {
    get(current, extend, multiple) {
      const target = tablePointerPosition(view, current)
      const head = target?.position ?? view.posAtCoords({ x: current.clientX, y: current.clientY }, false) ?? anchor
      const range = EditorSelection.range(extend ? original.main.anchor : anchor, head, undefined, undefined, target?.assoc)
      return multiple ? original.addRange(range) : EditorSelection.create([range])
    },
    update(update) {
      if (update.docChanged) {
        anchor = update.changes.mapPos(anchor)
        original = original.map(update.changes)
        return true
      }
    },
  }
})

const tableComposition = StateEffect.define<boolean>()
const tableCompositionState = StateField.define({
  create: () => false,
  update: (value: boolean, transaction) => {
    for (const effect of transaction.effects) if (effect.is(tableComposition)) value = effect.value
    return value
  },
})

// Native input and model/undo restoration recreate selections with assoc=0.
// At a cell's trailing pipe this puts the DOM caret in the next wrapper even
// though the source head remains in the edited cell. Normalize only affinity,
// in the same transaction; never move the source position or add history.
const tableCaretSelection = EditorState.transactionFilter.of(transaction => {
  const selection = transaction.newSelection, range = selection.main
  let composing = transaction.startState.field(tableCompositionState, false) ?? false
  for (const effect of transaction.effects) if (effect.is(tableComposition)) composing = effect.value
  if (selection.ranges.length !== 1 || !range.empty || range.assoc < 0
    || composing || transaction.isUserEvent('input.type.compose')
    || transaction.newDoc.sliceString(range.head, Math.min(range.head + 1, transaction.newDoc.length)) !== '|') return transaction
  const state = transaction.state
  const table = getContinuousBlockLine(state.doc, syntaxTree(state), state.doc.lineAt(range.head)).table
  if (!table || table.separator || !table.cells.some(cell => cell.to === range.head)) return transaction
  return [transaction, { selection: EditorSelection.create([
    EditorSelection.range(range.anchor, range.head, range.goalColumn, range.bidiLevel ?? undefined, -1),
  ]), sequential: true }]
})

function repairTableCaret(view: EditorView) {
  const range = view.state.selection.main, native = view.dom.ownerDocument.getSelection()
  if (!view.hasFocus || view.state.selection.ranges.length !== 1 || !range.empty || range.head === 0 || !native?.isCollapsed
    || view.state.doc.sliceString(range.head, Math.min(range.head + 1, view.state.doc.length)) !== '|') return
  const cellAt = (node: Node | null) => (node?.nodeType === 1 ? node as Element : node?.parentElement)?.closest('.looma-continuous-table-cell')
  // Looking one source character back identifies the ending cell, including
  // an empty cell (its leading pipe), without choosing the next wrapper.
  const point = view.domAtPos(range.head - 1), cell = cellAt(point.node), offset = point.offset + 1
  if (!cell || cellAt(native.focusNode) === cell) return
  const length = point.node.nodeType === 3 ? point.node.nodeValue?.length ?? 0 : point.node.childNodes.length
  if (offset > length || view.posAtDOM(point.node, offset) !== range.head) return
  // CM considers adjacent wrapper edges equivalent, but CSS table cells put
  // them in different boxes. Repair native selection after composition cleanup
  // without changing the source position, document, or undo history.
  native.collapse(point.node, offset)
}

/** Selection only changes display; source and history remain model-owned. */
export function continuousMarkdown(options: ContinuousMarkdownOptions): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none
    cells: DecorationSet = Decoration.none
    atomic: DecorationSet = Decoration.none
    composing = false
    dragging = false
    frozenSelection: SourceRange | undefined
    refreshFrame = 0
    caretFrame = 0
    constructor(readonly view: EditorView) {
      this.build(view, this.selection(view))
      view.dom.ownerDocument.addEventListener('mouseup', this.finishDrag)
      view.dom.ownerDocument.addEventListener('pointercancel', this.finishDrag)
    }
    selection(view: EditorView) {
      const { from, to } = view.state.selection.main
      return view.hasFocus ? { from, to } : undefined
    }
    refresh() {
      cancelAnimationFrame(this.refreshFrame)
      this.refreshFrame = requestAnimationFrame(() => {
        this.refreshFrame = 0
        if (this.view.dom.isConnected) this.view.dispatch({ effects: [refreshContinuousMarkdown.of(null), tableComposition.of(this.composing)] })
      })
    }
    finishDrag = () => {
      if (!this.dragging) return
      this.dragging = false
      this.frozenSelection = undefined
      this.refresh()
    }
    build(view: EditorView, selection?: SourceRange) {
      const plan = buildContinuousMarkdownPlan(view.state.doc, view.visibleRanges, { ...options, tree: syntaxTree(view.state) }, selection)
      const ranges = [], atoms = [], cells = []
      for (const line of plan.lines) ranges.push(Decoration.line({ class: line.className, attributes: { ...line.attributes, 'data-line': String(line.line) } }).range(line.from))
      for (const mark of plan.marks) {
        if (mark.className === 'looma-continuous-table-cell') {
          // Insertions at a shared edge belong to the cell ending there, not
          // also to the next cell. Keep frozen IME ranges non-overlapping.
          cells.push(Decoration.mark({ class: mark.className, attributes: mark.attributes, inclusiveStart: false, inclusiveEnd: true }).range(mark.from, mark.to))
          continue
        }
        const link = mark.href && !/^(?:javascript|data|vbscript):/i.test(mark.href)
        const decoration = Decoration.mark({ class: mark.className, attributes: mark.attributes, ...(link ? { tagName: 'a', attributes: { ...mark.attributes, href: mark.href!, 'data-href': mark.href! } } : {}) })
        ranges.push(decoration.range(mark.from, mark.to))
        if (mark.className === 'looma-continuous-table-syntax') atoms.push(decoration.range(mark.from, mark.to))
      }
      for (const range of plan.replacements) {
        const widget = range.kind === 'bullet' ? new BulletWidget(range.text)
          : range.kind === 'task' ? new TaskWidget(range.from, !!range.checked, view.state.readOnly)
            : range.kind === 'rule' ? new StructuralWidget() : undefined
        if (range.from === range.to) {
          if (widget) ranges.push(Decoration.widget({ widget }).range(range.from))
        } else {
          const decoration = Decoration.replace(widget ? { widget } : {})
          ranges.push(decoration.range(range.from, range.to)); atoms.push(decoration.range(range.from, range.to))
        }
      }
      for (const image of plan.images) {
        const decoration = Decoration.replace({ widget: new ImageWidget(image, options.resolveImage) })
        ranges.push(decoration.range(image.from, image.to)); atoms.push(decoration.range(image.from, image.to))
      }
      if (plan.title) ranges.push(Decoration.widget({ widget: new ReadingTimeWidget(plan.title.minutes, plan.title.words), side: 1 }).range(plan.title.at))
      this.decorations = Decoration.set(ranges, true)
      this.cells = Decoration.set(cells, true)
      this.atomic = Decoration.set(atoms, true)
    }
    update(update: ViewUpdate) {
      if (this.composing || update.view.composing) {
        this.decorations = this.decorations.map(update.changes)
        this.cells = this.cells.map(update.changes)
        this.atomic = this.atomic.map(update.changes)
      } else if (this.dragging) {
        if (update.viewportChanged) this.build(update.view, this.frozenSelection)
        else {
          this.decorations = this.decorations.map(update.changes)
          this.cells = this.cells.map(update.changes)
          this.atomic = this.atomic.map(update.changes)
        }
      } else if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || update.state.readOnly !== update.startState.readOnly || syntaxTree(update.state) !== syntaxTree(update.startState)
        || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshContinuousMarkdown)))) this.build(update.view, this.selection(update.view))
      cancelAnimationFrame(this.caretFrame)
      this.caretFrame = requestAnimationFrame(() => {
        this.caretFrame = 0
        if (!this.composing && !this.dragging && !this.view.composing && this.view.dom.isConnected) repairTableCaret(this.view)
      })
    }
    destroy() {
      cancelAnimationFrame(this.refreshFrame)
      cancelAnimationFrame(this.caretFrame)
      this.view.dom.ownerDocument.removeEventListener('mouseup', this.finishDrag)
      this.view.dom.ownerDocument.removeEventListener('pointercancel', this.finishDrag)
    }
  }, {
    decorations: plugin => plugin.decorations,
    provide: plugin => [
      EditorView.atomicRanges.of(view => view.plugin(plugin)?.atomic ?? Decoration.none),
      EditorView.outerDecorations.of(view => view.plugin(plugin)?.cells ?? Decoration.none),
      tableMouseSelection,
      tableCompositionState,
      tableCaretSelection,
      continuousTableInput,
    ],
    eventHandlers: {
      mousedown(event, view) {
        if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          this.frozenSelection = this.selection(view)
          this.dragging = true
        }
        return false
      },
      blur() { this.finishDrag(); return false },
      compositionstart(_event, view) {
        this.composing = true
        view.dispatch({ effects: tableComposition.of(true) })
        return false
      },
      compositionend() {
        this.composing = false
        this.refresh()
        return false
      },
    },
  })
}
