import type { Line, Text } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'

export type BlockSourceRange = { from: number; to: number }
type BlockSourceDocument = Pick<Text, 'length' | 'lineAt' | 'sliceString'>
export type ContinuousBlockLine = {
  literal: boolean
  html?: boolean
  heading?: { level: number; from: number; titleAt: number }
  setextMarker?: boolean
  quoteDepth: number
  listDepth: number
  markers: BlockSourceRange[]
  listMarker?: BlockSourceRange & { text: string }
  task?: BlockSourceRange & { checked: boolean }
  rule?: boolean
  hardBreak?: boolean
  table?: { from: number; to: number; columns: number; header: boolean; separator: boolean; align: ('left' | 'center' | 'right')[]; cells: BlockSourceRange[]; delimiters: BlockSourceRange[] }
}

const range = (node: SyntaxNode): BlockSourceRange => ({ from: node.from, to: node.to })
const tableConfigurations = new WeakMap<Tree, Map<number, Pick<NonNullable<ContinuousBlockLine['table']>, 'columns' | 'align'>>>()

function tableCells(row: SyntaxNode): BlockSourceRange[] {
  const result: BlockSourceRange[] = []
  let start = row.from
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'TableDelimiter') continue
    if (child.from > start) result.push({ from: start, to: child.from })
    else if (child.from > row.from) result.push({ from: start, to: start })
    start = child.to
  }
  if (start < row.to) result.push({ from: start, to: row.to })
  return result
}

/** Query only a rendered line and its parsed ancestors; never read a whole block. */
export function getContinuousBlockLine(doc: BlockSourceDocument, tree: Tree, line: Line): ContinuousBlockLine {
  const result: ContinuousBlockLine = { literal: false, quoteDepth: 0, listDepth: 0, markers: [] }
  const prefix = doc.sliceString(line.from, Math.min(line.to, line.from + 512))
  const markup = /^(?:[\t ]*(?:>[\t ]?|(?:[-+*]|\d+[.)])[\t ]+|\[[ xX]\][\t ]+))*[\t ]*/.exec(prefix)![0].length
  const nodes: SyntaxNode[] = []
  for (let node = tree.resolveInner(Math.min(line.to, line.from + markup), 1); node; node = node.parent) {
    if (node.to > line.from && node.from <= line.to) nodes.push(node)
  }
  result.quoteDepth = nodes.filter(node => node.name === 'Blockquote').length
  result.listDepth = nodes.filter(node => node.name === 'ListItem').length
  result.html = nodes.some(node => node.name === 'HTMLBlock' || node.name === 'CommentBlock')
  result.literal = result.html || nodes.some(node => node.name === 'FencedCode' || node.name === 'CodeBlock')
  if (result.literal) {
    tree.iterate({ from: line.from, to: Math.min(line.to, line.from + 512), enter(node) {
      if (node.from < line.from || node.from > line.to) return
      if (node.name === 'QuoteMark' || node.name === 'ListMark') {
        const marker = { from: node.from, to: Math.min(line.to, node.to + (doc.sliceString(node.to, Math.min(line.to, node.to + 1)) === ' ' ? 1 : 0)) }
        result.markers.push(marker)
        if (node.name === 'ListMark') result.listMarker = { ...marker, text: doc.sliceString(node.from, node.to) }
      } else if (node.name === 'CodeText' || node.name === 'CodeMark') {
        const from = Math.max(line.from, ...result.markers.map(marker => marker.to))
        if (node.from > from && /^[\t ]+$/.test(doc.sliceString(from, node.from))) result.markers.push({ from, to: node.from })
      }
    } })
    return result
  }

  const heading = nodes.find(node => /^(?:ATX|Setext)Heading[1-6]$/.test(node.name))
  if (heading) {
    const setext = heading.name.startsWith('Setext')
    const marker = heading.getChild('HeaderMark')
    result.heading = { level: Number(heading.name.slice(-1)), from: heading.from,
      titleAt: setext && marker ? doc.lineAt(Math.max(heading.from, marker.from - 1)).to : heading.to }
    result.setextMarker = !!(setext && marker && marker.from >= line.from && marker.to <= line.to)
  }
  result.rule = nodes.some(node => node.name === 'HorizontalRule')
  tree.iterate({ from: line.from, to: Math.min(line.to, line.from + 512), enter(node) {
    if (node.name === 'HardBreak' && node.from >= line.from && node.to === line.to + 1) {
      result.hardBreak = true
      result.markers.push({ from: node.from, to: line.to })
    }
    if (node.from < line.from || node.to > line.to) return
    if (['QuoteMark', 'ListMark', 'HeaderMark'].includes(node.name)) {
      const marker = { from: node.from, to: Math.min(line.to, node.to + (doc.sliceString(node.to, Math.min(line.to, node.to + 1)) === ' ' ? 1 : 0)) }
      result.markers.push(marker)
      if (node.name === 'ListMark') result.listMarker = { ...marker, text: doc.sliceString(node.from, node.to) }
    } else if (node.name === 'TaskMarker') result.task = { from: node.from, to: node.to, checked: /[xX]/.test(doc.sliceString(node.from, node.to)) }
  } })

  const table = nodes.find(node => node.name === 'Table')
  const row = nodes.find(node => node.name === 'TableHeader' || node.name === 'TableRow')
  const separator = nodes.find(node => node.name === 'TableDelimiter' && node.parent?.name === 'Table')
  if (table && (row || separator)) {
    const header = table.getChild('TableHeader')!
    const delimiter = table.getChild('TableDelimiter')!
    // Header/delimiter are single source lines; cap malformed giant rows rather
    // than reading a whole table during a scroll/selection update.
    if (header.to - header.from <= 2048 && delimiter.to - delimiter.from <= 2048 && (!row || row.to - row.from <= 4096)) {
      let configurations = tableConfigurations.get(tree)
      if (!configurations) tableConfigurations.set(tree, configurations = new Map())
      let configuration = configurations.get(table.from)
      if (!configuration) {
        const alignment = doc.sliceString(delimiter.from, delimiter.to).trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
        configuration = { columns: tableCells(header).length, align: alignment.map(cell => /^\s*:.*:\s*$/.test(cell) ? 'center' : /:\s*$/.test(cell) ? 'right' : 'left') }
        configurations.set(table.from, configuration)
      }
      result.table = { ...configuration, from: table.from, to: table.to, header: row?.name === 'TableHeader', separator: !!separator,
        cells: row ? tableCells(row) : [], delimiters: row ? row.getChildren('TableDelimiter').map(range) : [range(separator!)] }
    }
  }
  return result
}
