import { ChangeSet, EditorState, Text, Transaction } from '@codemirror/state'
import { history, isolateHistory, undo as undoHistory, redo as redoHistory } from '@codemirror/commands'
import { getExternalTextChange } from './editor-content-sync'

export type ChunkSelection = { anchor: number; head: number }
export type SourceChunk = {
  id: string
  from: number
  to: number
  /** Inclusive 1-based LF line numbers, matching lineAt/offsetForLine. */
  startLine: number
  endLine: number
  renderMode: 'markdown' | 'source'
}

type LineContext = {
  phase: 'indent' | 'marker' | 'tail' | 'text'
  indent: number
  marker: string
  count: number
  whitespaceTail: boolean
  backtickTail: boolean
  complex: boolean
}
type ParseContext = {
  fence: string
  fenceLength: number
  paragraph: boolean
  complex: boolean
  line: LineContext
}
type IndexedChunk = { chunk: SourceChunk; before: ParseContext; after: ParseContext }

function emptyLine(): LineContext {
  return { phase: 'indent', indent: 0, marker: '', count: 0,
    whitespaceTail: true, backtickTail: false, complex: false }
}
function initialContext(): ParseContext {
  return { fence: '', fenceLength: 0, paragraph: false, complex: false, line: emptyLine() }
}
function copyContext(context: ParseContext): ParseContext {
  return { ...context, line: { ...context.line } }
}
function safeBoundary(context: ParseContext): boolean {
  return !context.fence && !context.paragraph && !context.complex
    && context.line.phase === 'indent' && context.line.indent === 0
}

/** Streaming line classification keeps even an enormous line's state bounded. */
function readCharacter(context: ParseContext, char: string): void {
  const line = context.line
  if (line.phase === 'indent') {
    if (char === ' ' || char === '\t') {
      line.indent = Math.min(4, line.indent + (char === '\t' ? 4 : 1))
      return
    }
    line.complex = line.indent >= 4 || '<[]>*+-0123456789'.includes(char)
    if (line.indent <= 3 && (char === '`' || char === '~')) {
      line.phase = 'marker'
      line.marker = char
      line.count = 1
    } else line.phase = 'text'
  } else if (line.phase === 'marker' && char === line.marker) {
    line.count++
  } else if (line.phase === 'marker' || line.phase === 'tail') {
    line.phase = 'tail'
    if (char !== ' ' && char !== '\t') line.whitespaceTail = false
    if (char === '`') line.backtickTail = true
  }
}
function finishLine(context: ParseContext): void {
  const line = context.line
  const marker = line.count >= 3 && (line.phase === 'marker' || line.phase === 'tail')
  if (context.fence) {
    if (marker && line.marker === context.fence && line.count >= context.fenceLength && line.whitespaceTail) {
      context.fence = ''
      context.fenceLength = 0
    }
  } else if (marker && (line.marker !== '`' || !line.backtickTail)) {
    context.fence = line.marker
    context.fenceLength = line.count
    context.paragraph = true
  } else if (line.phase === 'indent') {
    context.paragraph = false
  } else {
    context.paragraph = true
    // Lists, quotes, indented code and HTML may survive blank lines. Without a
    // full Markdown parser their continuation is deliberately never guessed.
    context.complex ||= line.complex
  }
  context.line = emptyLine()
}

/** One immutable CodeMirror rope is the authoritative, lossless source. */
export class ChunkedDocument {
  private state: EditorState
  private snapshot: string | undefined
  private index: SourceChunk[]
  private entries: IndexedChunk[] = []
  private nextId = 0
  private version = 0
  private revisionChanges: ChangeSet[] = []

  constructor(content: string, private readonly maxChunkChars = 8192) {
    if (!Number.isInteger(maxChunkChars) || maxChunkChars < 2) {
      throw new RangeError('maxChunkChars must be an integer of at least 2')
    }
    this.state = EditorState.create({
      doc: Text.of(content.split('\n')),
      extensions: [EditorState.lineSeparator.of('\n'), history({ minDepth: 1000 })],
    })
    this.snapshot = content
    this.index = []
    this.rebuildIndex()
  }

  private rebuildIndex(): void {
    this.index = []
    this.entries = []
    let from = 0
    let context = initialContext()
    do {
      const entry = this.scanChunk(from, context)
      this.entries.push(entry)
      this.index.push(entry.chunk)
      from = entry.chunk.to
      context = entry.after
    } while (from < this.length)
  }

  /** Immutable canonical rope; reading it never flattens source. */
  get text(): Text { return this.state.doc }
  get length(): number { return this.state.doc.length }
  get revision(): number { return this.version }
  /** Compose retained source transitions, never selection-only transactions. */
  changesSince(revision: number): ChangeSet | null {
    const firstRevision = this.version - this.revisionChanges.length
    if (!Number.isInteger(revision) || revision < firstRevision || revision > this.version) return null
    if (revision === this.version) return ChangeSet.empty(this.length)
    const changes = this.revisionChanges.slice(revision - firstRevision)
    return changes.slice(1).reduce((composed, change) => composed.compose(change), changes[0])
  }
  get selection(): ChunkSelection {
    const { anchor, head } = this.state.selection.main
    return { anchor, head }
  }
  get chunks(): readonly SourceChunk[] { return this.index }
  get content(): string { return this.snapshot ??= this.state.doc.toString() }
  slice(from: number, to: number): string { return this.state.doc.sliceString(from, to) }
  /** 1-based CodeMirror lines (LF separators); CR bytes are source content. */
  lineAt(offset: number): { number: number; from: number; to: number } {
    const { number, from, to } = this.state.doc.lineAt(this.clamp(offset, this.length))
    return { number, from, to }
  }
  offsetForLine(lineNumber: number): number {
    return this.state.doc.line(Math.max(1, this.clamp(lineNumber, this.state.doc.lines))).from
  }
  getChunkAt(offset: number): SourceChunk {
    const pos = this.clamp(offset, this.length)
    let lo = 0, hi = this.index.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (this.index[mid].from <= pos) lo = mid
      else hi = mid - 1
    }
    return this.index[lo]
  }
  /** Fence state immediately before a source offset, scanning one indexed chunk. */
  contextAt(offset: number): { fence: string; fenceLength: number } {
    let position = this.clamp(offset, this.length)
    // A CRLF is one boundary; a query between its code units has not consumed it.
    if (position > 0 && this.slice(position - 1, Math.min(this.length, position + 1)) === '\r\n') position--
    let low = 0, high = this.entries.length - 1
    while (low < high) {
      const middle = (low + high + 1) >>> 1
      if (this.entries[middle].chunk.from <= position) low = middle
      else high = middle - 1
    }
    const entry = this.entries[low]
    const context = copyContext(entry.before)
    const source = this.slice(entry.chunk.from, position)
    for (let index = 0; index < source.length; index++) {
      const char = source[index]
      if (char === '\r' || char === '\n') {
        if (char === '\r' && source[index + 1] === '\n') index++
        finishLine(context)
      } else readCharacter(context, char)
    }
    return { fence: context.fence, fenceLength: context.fenceLength }
  }
  /** Selection-only transactions never invalidate the source snapshot/revision. */
  select(anchor: number, head = anchor): void {
    this.state = this.state.update({ selection: this.validSelection(this.state.doc, { anchor, head }) }).state
  }
  replace(from: number, to: number, insert: string, selection?: ChunkSelection): boolean {
    return this.applyChanges([{ from, to, insert }], selection ?? { anchor: from + insert.length, head: from + insert.length })
  }
  /** All change coordinates refer to the document before this atomic batch. */
  applyChanges(changes: readonly { from: number; to: number; insert: string }[], selection?: ChunkSelection, userEvent?: string): boolean {
    const ordered = [...changes].sort((a, b) => a.from - b.from || a.to - b.to)
    let previousTo = 0
    for (const change of ordered) {
      if (!Number.isInteger(change.from) || !Number.isInteger(change.to)
        || change.from < previousTo || change.from < 0 || change.to < change.from || change.to > this.length) {
        throw new RangeError('Changes must be non-overlapping valid UTF-16 ranges')
      }
      previousTo = change.to
    }
    const effective = ordered.filter(change => this.slice(change.from, change.to) !== change.insert)
    if (!effective.length) {
      if (selection) this.select(selection.anchor, selection.head)
      return false
    }
    const changeSet = this.state.changes(effective.map(change => ({ ...change, insert: Text.of(change.insert.split('\n')) })))
    const nextDoc = changeSet.apply(this.state.doc)
    const mapped = this.state.selection.main.map(changeSet)
    const nextSelection = this.validSelection(nextDoc, selection ?? mapped)
    // Keep ordinary operations isolated, but preserve CM's compose.start/compose
    // tags so its native history joins one IME session, including the commit.
    this.accept(this.state.update({ changes: changeSet, selection: nextSelection,
      annotations: [isolateHistory.of('full'), ...(userEvent ? [Transaction.userEvent.of(userEvent)] : [])] }))
    // CodeMirror records a change's *before* selection. A selection transaction
    // also records its after-selection so redo restores arbitrary cross-chunk
    // ranges, not merely the old range mapped through the replacement.
    this.state = this.state.update({ selection: this.state.selection }).state
    return true
  }
  /** Rebase known save-time canonicalization, not arbitrary external edits. */
  reconcileSavedContent(content: string): boolean {
    const change = getExternalTextChange(this.content, content)
    if (!change) return false
    this.accept(this.state.update({
      changes: { ...change, insert: Text.of(change.insert.split('\n')) },
      annotations: Transaction.addToHistory.of(false),
    }))
    this.snapshot = content
    return true
  }
  /** Equal persistence echoes are not new documents and must keep history. */
  replaceExternal(content: string): boolean {
    if (this.snapshot !== undefined && this.snapshot === content) return false
    const doc = Text.of(content.split('\n'))
    if (this.state.doc.eq(doc)) return false
    const changes = ChangeSet.of({ from: 0, to: this.length, insert: doc }, this.length)
    const selection = this.validSelection(doc, this.selection)
    this.state = EditorState.create({ doc, selection,
      extensions: [EditorState.lineSeparator.of('\n'), history({ minDepth: 1000 })] })
    this.snapshot = content
    this.version++
    this.revisionChanges.push(changes)
    if (this.revisionChanges.length > 128) this.revisionChanges.shift()
    this.rebuildIndex()
    return true
  }
  undo(): boolean {
    return undoHistory({ state: this.state, dispatch: transaction => this.accept(transaction) })
  }
  redo(): boolean {
    return redoHistory({ state: this.state, dispatch: transaction => this.accept(transaction) })
  }
  private validSelection(doc: Text, selection: ChunkSelection): ChunkSelection {
    const valid = (value: number): number => {
      const offset = this.clamp(value, doc.length)
      return this.splitPair(doc, offset) ? offset - 1 : offset
    }
    return { anchor: valid(selection.anchor), head: valid(selection.head) }
  }
  private accept(transaction: Transaction): void {
    if (!transaction.docChanged) {
      this.state = transaction.state
      return
    }
    let first = transaction.startState.doc.length
    let oldEnd = 0, newEnd = 0
    transaction.changes.iterChanges((fromA, toA, _fromB, toB) => {
      first = Math.min(first, fromA)
      oldEnd = toA
      newEnd = toB
    })
    const old = this.entries
    const delta = transaction.newDoc.length - transaction.startState.doc.length
    const lowerBound = (offset: number): number => {
      let lo = 0, hi = old.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (old[mid].chunk.from < offset) lo = mid + 1
        else hi = mid
      }
      return lo
    }
    const containing = Math.min(old.length - 1, lowerBound(first + 1) - 1)
    // The previous chunk may have ended at a blank line changed by this edit,
    // or at a CR/surrogate now joining the next chunk. Recheck that edge too.
    const restart = Math.max(0, containing - 1)
    const next = old.slice(0, restart)
    let from = old[restart].chunk.from
    let context = old[restart].before
    this.state = transaction.state
    this.version++
    this.revisionChanges.push(transaction.changes)
    if (this.revisionChanges.length > 128) this.revisionChanges.shift()
    this.snapshot = undefined

    do {
      const oldOffset = from - delta
      const match = lowerBound(oldOffset)
      const candidate = old[match]
      if (from >= newEnd && oldOffset >= oldEnd && candidate?.chunk.from === oldOffset
        && (candidate.chunk.to > candidate.chunk.from || this.length === 0)
        && !this.isSplitPair(from) && this.sameContext(context, candidate.before)) {
        const lineDelta = this.lineAt(from).number - candidate.chunk.startLine
        for (let i = match; i < old.length; i++) {
          const entry = old[i]
          next.push(!delta && !lineDelta ? entry : { ...entry, chunk: {
            ...entry.chunk, from: entry.chunk.from + delta, to: entry.chunk.to + delta,
            startLine: entry.chunk.startLine + lineDelta, endLine: entry.chunk.endLine + lineDelta,
          } })
        }
        break
      }
      // Aim for an existing suffix boundary as soon as the changed span is
      // behind us. This also converges on a giant unbroken physical line,
      // where blindly taking max-sized slices would shift every boundary.
      let limit = Math.min(this.length, from + this.maxChunkChars)
      const endIndex = lowerBound(limit - delta + 1) - 1
      const target = old[endIndex]?.chunk.from
      if (target !== undefined && target >= oldEnd && target + delta >= newEnd
        && target + delta > from && !this.isSplitPair(target + delta)) {
        limit = target + delta
      }
      let entry = this.scanChunk(from, context, limit)
      const previous = old[lowerBound(from)]
      if (previous?.chunk.from === from && previous.chunk.to === entry.chunk.to
        && entry.chunk.to <= first && this.sameContext(previous.after, entry.after)
        && previous.chunk.renderMode === entry.chunk.renderMode) entry = previous
      next.push(entry)
      from = entry.chunk.to
      context = entry.after
    } while (from < this.length)
    this.entries = next
    this.index = next.map(entry => entry.chunk)
  }
  private sameContext(left: ParseContext, right: ParseContext): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
  }
  private scanChunk(from: number, before: ParseContext, limit = this.length): IndexedChunk {
    let to = Math.min(limit, from + this.maxChunkChars)
    if (to < this.length && this.isSplitPair(to)) to--
    const source = this.slice(from, to)
    let after = copyContext(before)
    let lastSafe = 0
    let safeContext: ParseContext | undefined
    for (let i = 0; i < source.length; i++) {
      const char = source[i]
      if (char === '\r' || char === '\n') {
        if (char === '\r' && source[i + 1] === '\n') i++
        finishLine(after)
        if (safeBoundary(after)) {
          lastSafe = i + 1
          safeContext = copyContext(after)
        }
      } else readCharacter(after, char)
    }
    // End early at a known independent block, even if the following block
    // would fit partially. Never trim or normalize the source at a boundary.
    if (lastSafe && from + lastSafe < to) {
      to = from + lastSafe
      after = safeContext!
    }
    const eofContext = copyContext(after)
    if (to === this.length) finishLine(eofContext)
    const independentEnd = safeBoundary(after)
      || (to === this.length && !eofContext.fence && !eofContext.complex)
    return {
      chunk: { id: `chunk-${this.nextId++}`, from, to,
        startLine: this.lineAt(from).number,
        endLine: this.lineAt(Math.max(from, to - 1)).number,
        renderMode: safeBoundary(before) && independentEnd ? 'markdown' : 'source' },
      before, after,
    }
  }
  private clamp(value: number, max: number): number {
    return Number.isNaN(value) ? 0 : Math.max(0, Math.min(max, Math.trunc(value)))
  }
  private isSplitPair(offset: number): boolean { return this.splitPair(this.state.doc, offset) }
  private splitPair(doc: Text, offset: number): boolean {
    if (offset <= 0 || offset >= doc.length) return false
    const pair = doc.sliceString(offset - 1, offset + 1)
    return pair === '\r\n' || (pair.charCodeAt(0) >= 0xd800 && pair.charCodeAt(0) <= 0xdbff
      && pair.charCodeAt(1) >= 0xdc00 && pair.charCodeAt(1) <= 0xdfff)
  }
}
