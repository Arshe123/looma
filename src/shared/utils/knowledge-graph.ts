import MarkdownIt from 'markdown-it'
import { normalizeMarkdownNoteLinks } from './markdown-note-links'
import { parseNoteLinkHref, type NoteLinkAnchor } from './note-link-ref'
import type { MarkdownReference } from './markdown-reference-index'

export interface GraphCitation {
  target: string
  href: string
  snippet: string
  line: number
  anchor?: NoteLinkAnchor
  references?: Record<string, MarkdownReference>
}

export interface GraphNote {
  createdAt?: number
  contentLength?: number
  path: string
  title: string
  citations: GraphCitation[]
  error?: string
}

/** Bounded square-root sizing keeps both short and long notes readable. */
export function graphNodeRadius(note: Pick<GraphNote, 'contentLength'>): number {
  const length = Number.isFinite(note.contentLength) ? Math.max(0, note.contentLength || 0) : 0
  return Math.round((6 + Math.min(12, Math.sqrt(length) / 10)) * 4) / 4
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  citations: GraphCitation[]
}

const markdown = new MarkdownIt({ html: false })
const fileTitle = (path: string) => (path.split('/').pop() || path).replace(/\.(md|txt)$/i, '')

/** Parse tokens rather than matching source, so code, images and escaped links stay out. */
export function parseGraphNote(path: string, content: string): GraphNote {
  const note: GraphNote = { path, title: fileTitle(path), citations: [], contentLength: content.replace(/\s/g, '').length }
  if (!/\.md$/i.test(path)) return note
  const env: { references?: Record<string, MarkdownReference> } = {}
  const tokens = markdown.parse(normalizeMarkdownNoteLinks(content), env)
  const lines = content.split('\n')
  let titled = false
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.type !== 'inline') continue
    if (!titled && tokens[index - 1]?.type === 'heading_open') {
      note.title = token.children?.filter(child => child.type === 'text' || child.type === 'code_inline')
        .map(child => child.content).join('') || note.title
      titled = true
    }
    for (const child of token.children || []) {
      if (child.type !== 'link_open') continue
      const href = child.attrGet('href') || ''
      if (/^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(href)) continue
      // Reject links escaping the workspace instead of clamping ../ to its root.
      let decoded: string
      try { decoded = decodeURIComponent(href.split('#')[0]).replace(/\\/g, '/') } catch { decoded = href.split('#')[0] }
      let depth = path.split('/').length - 1
      let escaped = false
      for (const part of decoded.split('/')) {
        if (part === '..') { if (--depth < 0) escaped = true }
        else if (part && part !== '.') depth++
      }
      if (escaped) continue
      const ref = parseNoteLinkHref(href, path)
      if (!ref) continue
      note.citations.push({ target: ref.relativePath, href, anchor: ref.anchor,
        snippet: (token.map ? lines.slice(token.map[0], token.map[1]).join('\n') : token.content).trim().slice(0, 220),
        line: (token.map?.[0] || 0) + 1,
        references: env.references })
    }
  }
  return note
}

export function buildGraphEdges(notes: GraphNote[]): { edges: GraphEdge[]; missing: Map<string, GraphCitation[]> } {
  const paths = new Set(notes.map(note => note.path))
  const edges = new Map<string, GraphEdge>()
  const missing = new Map<string, GraphCitation[]>()
  for (const note of notes) for (const citation of note.citations) {
    if (!paths.has(citation.target)) {
      const list = missing.get(note.path) || []
      list.push(citation)
      missing.set(note.path, list)
      continue
    }
    const id = JSON.stringify([note.path, citation.target])
    const edge = edges.get(id) || { id, source: note.path, target: citation.target, citations: [] }
    edge.citations.push(citation)
    edges.set(id, edge)
  }
  return { edges: [...edges.values()], missing }
}

export interface GraphNode { note: GraphNote; x: number; y: number }
export interface GraphLayout { nodes: GraphNode[]; width: number; height: number }

/** Bottom-up directory branches, with chronological notes growing upwards.
 * Directories guide placement without becoming visible nodes or containers.
 */
export function layoutKnowledgeNotes(notes: GraphNote[], width = 1200, height = 800): GraphLayout {
  interface Branch { notes: GraphNote[]; children: Map<string, Branch> }
  interface Crown { nodes: GraphNode[]; left: number; right: number; top: number; bottom: number }
  const branch = (): Branch => ({ notes: [], children: new Map() })
  const root = branch()
  for (const note of notes) {
    let current = root
    for (const part of note.path.split('/').slice(0, -1)) {
      if (!current.children.has(part)) current.children.set(part, branch())
      current = current.children.get(part)!
    }
    current.notes.push(note)
  }
  const time = (note: GraphNote) => note.createdAt && Number.isFinite(note.createdAt) && note.createdAt > 0 ? note.createdAt : Infinity
  const orderedChildren = (node: Branch) => [...node.children].sort(([a], [b]) => a.localeCompare(b)).map(([, child]) => child)
  const variation = (path: string, salt: number) => {
    let value = salt
    for (const character of path) value = Math.imul(value ^ character.charCodeAt(0), 16777619)
    return (value >>> 0) / 0xffffffff - .5
  }
  const grow = (node: Branch, depth: number): Crown => {
    node.notes.sort((a, b) => time(a) - time(b) || a.path.localeCompare(b.path))
    const count = node.notes.length
    const rows = Math.min(count, Math.max(1, Math.ceil(Math.sqrt(count * 1.15))))
    const rowCounts = Array.from({ length: rows }, () => 1)
    if (count > rows) {
      const weights = rowCounts.map((_, row) => row < Math.min(2, rows - 1) ? 0 : Math.pow(Math.sin(Math.PI * (row - 1) / (rows - 1)), .8) + .12)
      const total = weights.reduce((sum, weight) => sum + weight, 0)
      const shares = weights.map(weight => (count - rows) * weight / total)
      shares.forEach((share, row) => { rowCounts[row] += Math.floor(share) })
      const remainder = count - rowCounts.reduce((sum, columns) => sum + columns, 0)
      const priorities = shares.map((share, row) => ({ row, fraction: share % 1 })).sort((a, b) => b.fraction - a.fraction || a.row - b.row)
      for (let index = 0; index < remainder; index++) rowCounts[priorities[index].row]++
    }
    const nodes: GraphNode[] = []
    const ownWidth = Math.max(48, ...rowCounts.map(columns => (columns - 1) * 62 + 48))
    const ownHeight = Math.max(0, rows - 1) * 58
    let noteIndex = 0
    rowCounts.forEach((columns, row) => {
      const progress = row / Math.max(1, rows - 1)
      const bend = Math.sin(progress * Math.PI) * Math.min(36, ownWidth * .06) * (depth % 2 ? -1 : 1)
      for (let column = 0; column < columns; column++) {
        const note = node.notes[noteIndex++]
        nodes.push({ note,
          x: bend + (column - (columns - 1) / 2) * 62 + variation(note.path, 2166136261) * 13,
          y: -row * 58 + (row ? variation(note.path, 1315423911) * 12 : 0),
        })
      }
    })
    const children = orderedChildren(node).map(child => grow(child, depth + 1))
    const childWidth = (child: Crown) => child.right - child.left
    const attach = (child: Crown, centerX: number, bottomY: number) => {
      const shiftX = centerX - (child.left + child.right) / 2
      for (const point of child.nodes) nodes.push({ ...point, x: point.x + shiftX, y: point.y + bottomY - child.bottom })
    }
    if (!count) {
      const span = children.reduce((sum, child) => sum + childWidth(child), 0) + Math.max(0, children.length - 1) * 42
      let left = -span / 2
      for (const child of children) {
        attach(child, left + childWidth(child) / 2, 0)
        left += childWidth(child) + 42
      }
    } else if (count <= 3 && children.length === 1) {
      const child = children[0]
      const base = child.nodes.filter(point => point.y >= child.bottom - 20)
      const baseX = base.reduce((sum, point) => sum + point.x, 0) / Math.max(1, base.length)
      const shiftX = nodes[nodes.length - 1].x + (depth % 2 ? -16 : 16) - baseX
      for (const point of child.nodes) nodes.push({ ...point, x: point.x + shiftX, y: point.y - child.bottom - ownHeight - 58 })
    } else {
      const shoulder = -Math.max(ownHeight * .55, ownHeight <= 58 ? ownHeight + 62 : 72)
      let left = -ownWidth * .32 - 28, right = ownWidth * .32 + 28
      children.forEach((child, index) => {
        const side = children.length === 1 ? (depth % 2 ? -1 : 1) : index < Math.ceil(children.length / 2) ? -1 : 1
        const span = childWidth(child)
        attach(child, side < 0 ? left - span * .35 : right + span * .35, shoulder - Math.abs(index - (children.length - 1) / 2) * 18)
        if (side < 0) left -= span + 42
        else right += span + 42
      })
    }
    return { nodes, left: Math.min(0, ...nodes.map(point => point.x - graphNodeRadius(point.note) - 12)),
      right: Math.max(0, ...nodes.map(point => point.x + graphNodeRadius(point.note) + 12)),
      top: Math.min(0, ...nodes.map(point => point.y)), bottom: Math.max(0, ...nodes.map(point => point.y)) }
  }
  const crown = grow(root, 0)
  const worldWidth = Math.max(width, crown.right - crown.left + 128), worldHeight = Math.max(height, crown.bottom - crown.top + 128)
  const nodes = crown.nodes.map(point => ({ ...point, x: point.x + worldWidth / 2 - (crown.left + crown.right) / 2, y: point.y + worldHeight / 2 - (crown.top + crown.bottom) / 2 }))
  return { nodes, width: worldWidth, height: worldHeight }
}

