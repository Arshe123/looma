import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { ensureSyntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'
import { getContinuousBlockLine } from './continuousMarkdownBlocks'
import { getContinuousInlineSpans } from './continuousMarkdownSyntax'
import type { InlineMarkdownSpan } from '@/shared/utils/tiptap-inline-markdown'

type CommandView = Pick<EditorView, 'state' | 'dispatch'>
type Edit = { from: number; to?: number; insert?: string }
const inlineMarkers: Record<string, string> = { bold: '**', italic: '*', strike: '~~', inlineCode: '`', highlight: '==' }
const literalNames = /^(?:FencedCode|CodeBlock|HTMLBlock|CommentBlock)$/

function ancestors(tree: Tree, position: number): SyntaxNode[] {
  const nodes: SyntaxNode[] = []
  for (let node: SyntaxNode | null = tree.resolveInner(position, 1); node; node = node.parent) nodes.push(node)
  return nodes
}

function selectedLines(state: EditorState, selection: SelectionRange) {
  const first = state.doc.lineAt(selection.from).number
  const end = state.doc.lineAt(selection.to)
  const last = !selection.empty && end.from === selection.to ? end.number - 1 : end.number
  return Array.from({ length: last - first + 1 }, (_, i) => state.doc.line(first + i))
}

/** A single source transaction; the host remains the sole owner of history. */
function dispatchEdits(view: CommandView, edits: Edit[], caret?: number): boolean {
  if (!edits.length) return false
  edits.sort((a, b) => a.from - b.from || (a.to ?? a.from) - (b.to ?? b.from))
  const changes = view.state.changes(edits as ChangeSpec)
  const selection = caret === undefined ? EditorSelection.create(view.state.selection.ranges.map(range => {
    if (range.empty) return EditorSelection.cursor(changes.mapPos(range.head, 1))
    const from = changes.mapPos(range.from, 1), to = changes.mapPos(range.to, -1)
    return range.anchor <= range.head ? EditorSelection.range(from, Math.max(from, to)) : EditorSelection.range(Math.max(from, to), from)
  }), view.state.selection.mainIndex) : EditorSelection.cursor(caret)
  view.dispatch({ changes, selection, userEvent: 'input.format' })
  return true
}

// Container source is never wrapped in inline delimiters. This is a bounded
// prefix read even when the selected physical line is millions of characters.
function contentStart(state: EditorState, from: number, to: number) {
  const prefix = state.doc.sliceString(from, Math.min(to, from + 512))
  return from + /^(?:[\t ]*(?:>[\t ]?|(?:[-+*]|\d+[.)])[\t ]+|\[[ xX]\][\t ]+))*(?:#{1,6}[\t ]+)?/.exec(prefix)![0].length
}

function rangeStats(state: EditorState, from: number, to: number) {
  let trimFrom = to, trimTo = from, longestBackticks = 0, run = 0, offset = from, nonSpace = false
  for (const chunk of state.doc.iterRange(from, to)) {
    for (let i = 0; i < chunk.length; i++, offset++) {
      const character = chunk[i]
      if (!/\s/.test(character)) { trimFrom = Math.min(trimFrom, offset); trimTo = offset + 1 }
      if (character !== ' ') nonSpace = true
      run = character === '`' ? run + 1 : 0
      longestBackticks = Math.max(longestBackticks, run)
    }
  }
  return { trimFrom, trimTo, longestBackticks, nonSpace }
}

function spansAt(state: EditorState, tree: Tree, from: number, to: number): InlineMarkdownSpan[] {
  return getContinuousInlineSpans(state.doc, tree, from, to).map(span => {
    // The display helper intentionally caps code-padding reads. Commands can
    // inspect an explicitly affected long span with a rope iterator instead.
    if (span.type === 'inlineCode' && span.contentTo - span.contentFrom > 512
      && state.doc.sliceString(span.contentFrom, span.contentFrom + 1) === ' '
      && state.doc.sliceString(span.contentTo - 1, span.contentTo) === ' '
      && rangeStats(state, span.contentFrom, span.contentTo).nonSpace) {
      return { ...span, contentFrom: span.contentFrom + 1, contentTo: span.contentTo - 1 }
    }
    return span
  }).sort((a, b) => (a.to - a.from) - (b.to - b.from))
}

function inlineCommand(view: CommandView, action: string, tree: Tree): boolean {
  const state = view.state, selection = state.selection.main, marker = inlineMarkers[action]
  const lines = selectedLines(state, selection)
  let literal = false
  tree.iterate({ from: lines[0].from, to: lines[lines.length - 1].to, enter(node) {
    if (literalNames.test(node.name)) { literal = true; return false }
  } })
  if (literal) return false
  const enclosing = spansAt(state, tree, selection.from, selection.to).find(span => span.type === action
    && span.contentFrom <= selection.from && span.contentTo >= selection.to)
  if (enclosing) return dispatchEdits(view, [{ from: enclosing.from, to: enclosing.contentFrom }, { from: enclosing.contentTo, to: enclosing.to }])
  if (selection.empty) {
    const at = selection.head
    const emptyPair = state.doc.sliceString(Math.max(0, at - marker.length), Math.min(state.doc.length, at + marker.length)) === marker + marker
    if (emptyPair) return dispatchEdits(view, [{ from: at - marker.length, to: at + marker.length }], at - marker.length)
    return dispatchEdits(view, [{ from: at, insert: marker + marker }], at + marker.length)
  }
  const parts = lines.flatMap(line => {
    let from = Math.max(selection.from, contentStart(state, line.from, line.to)), to = Math.min(selection.to, line.to)
    if (from >= to) return []
    const stats = rangeStats(state, from, to)
    if (action !== 'inlineCode') {
      from = stats.trimFrom
      to = stats.trimTo
    }
    if (from >= to) return []
    const span = spansAt(state, tree, from, to).find(span => span.type === action
      && span.from <= from && span.to >= to)
    return [{ from, to, span, stats }]
  })
  const remove = parts.length > 0 && parts.every(part => part.span)
  const edits: Edit[] = []
  const removed = new Set<number>()
  for (const part of parts) {
    if (remove && part.span) {
      const span = part.span
      if (removed.has(span.from)) continue
      removed.add(span.from)
      edits.push({ from: span.from, to: span.contentFrom }, { from: span.contentTo, to: span.to })
    } else {
      let opening = marker, closing = marker
      if (action === 'inlineCode') {
        const delimiter = '`'.repeat(part.stats.longestBackticks + 1)
        const first = state.doc.sliceString(part.from, part.from + 1), last = state.doc.sliceString(part.to - 1, part.to)
        const padding = (first === '`' || last === '`' || first === ' ' || last === ' ') && part.stats.nonSpace ? ' ' : ''
        opening = delimiter + padding; closing = padding + delimiter
      }
      edits.push({ from: part.from, insert: opening }, { from: part.to, insert: closing })
    }
  }
  return dispatchEdits(view, edits)
}

function blockTargets(state: EditorState, tree: Tree) {
  return selectedLines(state, state.selection.main).map(line => {
    const info = getContinuousBlockLine(state.doc, tree, line)
    const prefix = state.doc.sliceString(line.from, Math.min(line.to, line.from + 512))
    const at = line.from + /^(?:[\t ]*(?:>[\t ]?|(?:[-+*]|\d+[.)])[\t ]+|\[[ xX]\][\t ]+))*[\t ]*/.exec(prefix)![0].length
    const heading = ancestors(tree, Math.min(line.to, Math.max(at, contentStart(state, line.from, line.to))))
      .find(node => /^(?:ATX|Setext)Heading[1-6]$/.test(node.name))
    return { line, info, at, heading }
  })
}

function headingEdits(state: EditorState, tree: Tree, levelFor: (current: number) => number): Edit[] | null {
  const targets = blockTargets(state, tree)
  if (targets.some(target => target.info.literal)) return null
  const edits: Edit[] = [], handled = new Set<number>()
  for (const { line, at, heading } of targets) {
    const current = heading ? Number(heading.name.slice(-1)) : 0
    const level = levelFor(current)
    if (current === level) continue
    const insert = level ? '#'.repeat(level) + ' ' : ''
    if (!heading) {
      edits.push({ from: at, insert })
    } else if (!handled.has(heading.from)) {
      handled.add(heading.from)
      const markers = heading.getChildren('HeaderMark')
      if (heading.name.startsWith('Setext')) {
        const underline = state.doc.lineAt(markers[0].from)
        edits.push({ from: underline.from - 1, to: underline.to })
        for (let n = state.doc.lineAt(heading.from).number; n < underline.number; n++) {
          const title = state.doc.line(n)
          const prefix = state.doc.sliceString(title.from, Math.min(title.to, title.from + 512))
          const start = title.from === state.doc.lineAt(heading.from).from ? heading.from
            : title.from + /^(?:[\t ]*(?:>[\t ]?|(?:[-+*]|\d+[.)])[\t ]+|\[[ xX]\][\t ]+))*[\t ]*/.exec(prefix)![0].length
          if (insert) edits.push({ from: start, insert })
        }
      } else {
        const opening = markers[0]
        const space = /^[\t ]*/.exec(state.doc.sliceString(opening.to, Math.min(line.to, opening.to + 256)))![0].length
        edits.push({ from: opening.from, to: opening.to + space, insert })
        if (markers.length > 1) {
          const closing = markers[markers.length - 1]
          const before = state.doc.sliceString(Math.max(opening.to, closing.from - 256), closing.from)
          edits.push({ from: closing.from - /[\t ]*$/.exec(before)![0].length, to: closing.to })
        }
      }
    }
  }
  return edits
}

function containerCommand(view: CommandView, action: string, tree: Tree): boolean {
  const state = view.state, targets = blockTargets(state, tree)
  if (targets.some(target => target.info.literal || target.info.setextMarker || target.info.rule)) return false
  const edits: Edit[] = []
  if (action === 'blockquote') {
    const remove = targets.every(target => target.info.quoteDepth > 0)
    for (const target of targets) {
      if (remove) {
        const marker = target.info.markers.filter(mark => state.doc.sliceString(mark.from, mark.from + 1) === '>').pop()
        if (marker) edits.push({ from: marker.from, to: marker.to })
      } else edits.push({ from: target.at, insert: '> ' })
    }
  } else {
    const normalized = new Map<number, typeof targets[number]>()
    for (const target of targets) {
      if (!target.info.listMarker) {
        const item = ancestors(tree, target.at).find(node => node.name === 'ListItem')
        if (item) {
          const line = state.doc.lineAt(item.from)
          const info = getContinuousBlockLine(state.doc, tree, line)
          normalized.set(line.from, { ...target, line, info })
          continue
        }
      }
      normalized.set(target.line.from, target)
    }
    const items = [...normalized.values()]
    const kind = (info: typeof targets[number]['info']) => info.task ? 'taskList' : info.listMarker ? (/^\d/.test(info.listMarker.text) ? 'orderedList' : 'bulletList') : ''
    const remove = items.every(target => kind(target.info) === action)
    const counters = new Map<number, number>(), indentDeltas = new Map<number, number>()
    for (const { line, info, at } of items) {
      const depth = info.listDepth
      const number = (counters.get(depth) || 0) + 1
      counters.set(depth, number)
      for (const key of counters.keys()) if (key > depth) counters.delete(key)
      const insert = remove ? '' : action === 'orderedList' ? `${number}. ` : action === 'taskList' ? '- [ ] ' : '- '
      const from = info.listMarker?.from ?? at
      let to = info.listMarker?.to ?? from
      if (info.task) to = info.task.to + (/^[\t ]/.test(state.doc.sliceString(info.task.to, info.task.to + 1)) ? 1 : 0)
      edits.push({ from, to, insert })
      if (!info.listMarker) continue
      const item = ancestors(tree, Math.min(line.to, to)).find(node => node.name === 'ListItem')
      const delta = (remove ? 0 : action === 'orderedList' ? `${number}. `.length : 2) - (info.listMarker.to - info.listMarker.from)
      if (!item || !delta) continue
      for (let n = line.number + 1; n <= state.doc.lineAt(Math.max(item.from, item.to - 1)).number; n++) {
        const child = state.doc.line(n)
        indentDeltas.set(child.from, (indentDeltas.get(child.from) || 0) + delta)
      }
    }
    for (const [from, delta] of indentDeltas) {
      const line = state.doc.lineAt(from)
      const prefix = state.doc.sliceString(from, Math.min(line.to, from + 512))
      const quote = /^(?:[\t ]*>[\t ]?)*/.exec(prefix)![0].length
      const indent = /^[\t ]*/.exec(prefix.slice(quote))![0]
      if (delta > 0) edits.push({ from: from + quote, insert: ' '.repeat(delta) })
      else edits.push({ from: from + quote, to: from + quote + Math.min(indent.length, -delta) })
    }
  }
  return dispatchEdits(view, edits)
}

function continuationPrefix(prefix: string) {
  return prefix.replace(/(?:[-+*]|\d+[.)])[\t ]+/g, marker => ' '.repeat(marker.length))
}

function codeBlockCommand(view: CommandView, tree: Tree): boolean {
  const state = view.state, selection = state.selection.main
  const targets = blockTargets(state, tree)
  const literals = new Map<number, SyntaxNode>()
  for (const target of targets) {
    const literal = ancestors(tree, target.at).find(node => node.name === 'FencedCode' || node.name === 'CodeBlock')
    if (literal) literals.set(literal.from, literal)
  }
  if (literals.size && targets.every(target => target.info.literal)) {
    const edits: Edit[] = []
    for (const literal of literals.values()) {
      const first = state.doc.lineAt(literal.from), last = state.doc.lineAt(literal.to)
      if (literal.name === 'CodeBlock') {
        for (let n = first.number; n <= last.number; n++) {
          const line = state.doc.line(n)
          const prefix = state.doc.sliceString(line.from, Math.min(line.to, line.from + 512))
          const quote = /^(?:[\t ]*>[\t ]?)*/.exec(prefix)![0].length
          const indent = /^(?: {1,4}|\t)/.exec(prefix.slice(quote))?.[0].length || 0
          if (indent) edits.push({ from: line.from + quote, to: line.from + quote + indent })
        }
      } else {
        const marks = literal.getChildren('CodeMark')
        const closing = marks.length > 1 ? state.doc.lineAt(marks[marks.length - 1].from) : undefined
        const prefix = continuationPrefix(state.doc.sliceString(first.from, literal.from))
        if (first.number === last.number) edits.push({ from: literal.from, to: first.to })
        else if (closing?.number === first.number + 1) {
          edits.push({ from: literal.from, to: closing.to })
        } else {
          const content = state.doc.line(first.number + 1)
          const actual = state.doc.sliceString(content.from, Math.min(content.to, content.from + prefix.length))
          edits.push({ from: literal.from, to: content.from + (actual === prefix ? prefix.length : 0) })
          if (closing) edits.push({ from: closing.from - 1, to: closing.to })
        }
      }
    }
    return dispatchEdits(view, edits)
  }
  if (targets.some(target => target.info.literal)) return false
  const groups: typeof targets[] = []
  for (const target of targets) {
    const group = groups[groups.length - 1]
    const previous = group?.[group.length - 1]
    if (!previous || target.info.listMarker || target.info.quoteDepth !== previous.info.quoteDepth || target.info.listDepth !== previous.info.listDepth) groups.push([target])
    else group.push(target)
  }
  const edits: Edit[] = []
  let caret: number | undefined
  for (const group of groups) {
    const first = group[0], last = group[group.length - 1]
    const prefix = continuationPrefix(state.doc.sliceString(first.line.from, first.at))
    // Inspect only selected source, in rope chunks, including backtick runs
    // crossing an iterator chunk boundary.
    const fence = '`'.repeat(Math.max(2, rangeStats(state, first.at, last.line.to).longestBackticks) + 1)
    const opening = fence + '\n' + prefix
    edits.push({ from: first.at, insert: opening }, { from: last.line.to, insert: '\n' + prefix + fence })
    if (selection.empty) caret = selection.head + opening.length
  }
  return dispatchEdits(view, edits, caret)
}

function horizontalRuleCommand(view: CommandView, tree: Tree): boolean {
  const targets = blockTargets(view.state, tree)
  if (targets.some(target => target.info.literal)) return false
  const last = targets[targets.length - 1]
  const prefix = continuationPrefix(view.state.doc.sliceString(last.line.from, last.at))
  const empty = last.at === last.line.to
  const insert = empty ? '---\n' + prefix : '\n' + prefix + '\n' + prefix + '---\n' + prefix
  return dispatchEdits(view, [{ from: last.line.to, insert }], view.state.selection.main.empty ? last.line.to + insert.length : undefined)
}

export function runContinuousMarkdownCommand(view: CommandView, action: string): boolean {
  if (view.state.readOnly) return false
  const tree = ensureSyntaxTree(view.state, view.state.selection.main.to, 100)
  if (!tree) return false
  if (Object.prototype.hasOwnProperty.call(inlineMarkers, action)) return inlineCommand(view, action, tree)
  if (action === 'codeBlock') return codeBlockCommand(view, tree)
  if (action === 'horizontalRule') return horizontalRuleCommand(view, tree)
  if (['bulletList', 'orderedList', 'taskList', 'blockquote'].includes(action)) return containerCommand(view, action, tree)
  if (action === 'paragraph' || /^h[1-6]$/.test(action)) {
    const level = action === 'paragraph' ? 0 : Number(action.slice(1))
    const toggleOff = level > 0 && blockTargets(view.state, tree).every(target => target.info.heading?.level === level)
    const edits = headingEdits(view.state, tree, () => toggleOff ? 0 : level)
    return edits !== null && dispatchEdits(view, edits)
  }
  return false
}

export function adjustContinuousHeading(view: CommandView, direction: 'up' | 'down'): boolean {
  if (view.state.readOnly) return false
  const tree = ensureSyntaxTree(view.state, view.state.selection.main.to, 100)
  if (!tree) return false
  const edits = headingEdits(view.state, tree, current => direction === 'up' ? (current === 0 ? 6 : Math.max(1, current - 1)) : (current === 0 || current === 6 ? 0 : current + 1))
  return edits !== null && dispatchEdits(view, edits)
}
