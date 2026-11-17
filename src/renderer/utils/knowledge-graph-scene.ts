import { graphNodeRadius } from '@/shared/utils/knowledge-graph'
import type { GraphEdge, GraphNode } from '@/shared/utils/knowledge-graph'

export interface GraphRect { x: number; y: number; width: number; height: number }
export interface GraphCamera { x: number; y: number; scale: number }
export function graphDirectoryHue(path: string): number {
  const parts = path.replace(/\\/g, '/').split('/').slice(0, -1)
  if (!parts.length) return 140
  const hash = (value: string) => {
    let result = 2166136261
    for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619)
    return result >>> 0
  }
  const base = hash(parts[0]) % 360
  const offset = parts.length > 1 ? hash(parts.slice(1).join('/')) % 45 - 22 : 0
  return (base + offset + 360) % 360
}
export const graphRectsIntersect = (a: GraphRect, b: GraphRect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/** Overscan and coarse cells avoid rebuilding the SVG scene on every pan pixel. */
export function graphRenderWindowKey(camera: GraphCamera, size: { width: number; height: number }): string {
  const tile = 256, margin = 96 / camera.scale
  const left = Math.floor((-camera.x / camera.scale - margin) / tile) * tile
  const top = Math.floor((-camera.y / camera.scale - margin) / tile) * tile
  const right = Math.ceil(((size.width - camera.x) / camera.scale + margin) / tile) * tile
  const bottom = Math.ceil(((size.height - camera.y) / camera.scale + margin) / tile) * tile
  return [left, top, right - left, bottom - top].join(',')
}
export function graphRectFromKey(key: string): GraphRect {
  const [x, y, width, height] = key.split(',').map(Number)
  return { x, y, width, height }
}

/** Points are indexed once per layout, not scanned for every camera frame. */
export class GraphNodeIndex {
  private cells = new Map<string, GraphNode[]>()
  constructor(nodes: GraphNode[], private tile = 256) {
    for (const node of nodes) {
      const key = `${Math.floor(node.x / tile)},${Math.floor(node.y / tile)}`
      const list = this.cells.get(key) || []
      list.push(node)
      this.cells.set(key, list)
    }
  }
  query(rect: GraphRect): GraphNode[] {
    const result: GraphNode[] = []
    const left = Math.floor(rect.x / this.tile), right = Math.floor((rect.x + rect.width) / this.tile)
    const top = Math.floor(rect.y / this.tile), bottom = Math.floor((rect.y + rect.height) / this.tile)
    // A zoomed-out viewport can span a very large empty world. Iterate occupied
    // cells instead when that is cheaper than visiting every possible tile.
    if ((right - left + 1) * (bottom - top + 1) > this.cells.size * 2) {
      for (const nodes of this.cells.values()) for (const node of nodes) {
        if (node.x >= rect.x && node.x <= rect.x + rect.width && node.y >= rect.y && node.y <= rect.y + rect.height) result.push(node)
      }
    } else {
      for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) {
        for (const node of this.cells.get(`${x},${y}`) || []) {
          if (node.x >= rect.x && node.x <= rect.x + rect.width && node.y >= rect.y && node.y <= rect.y + rect.height) result.push(node)
        }
      }
    }
    return result
  }
}

export function graphAdjacency(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const result = new Map<string, GraphEdge[]>()
  for (const edge of edges) for (const path of new Set([edge.source, edge.target])) {
    const list = result.get(path) || []
    list.push(edge)
    result.set(path, list)
  }
  return result
}
/** Hover previews one node; leaving restores the saved selection. */
export function graphInteractionEdges(adjacency: Map<string, GraphEdge[]>, selected: string, hovered: string): GraphEdge[] {
  return adjacency.get(hovered || selected) || []
}
export interface GraphSceneEdge { edge: GraphEdge; d: string; lineD: string; headD: string; bounds: GraphRect }
export const graphNoteName = (path: string) => (path.split('/').pop() || path).replace(/\.(md|txt)$/i, '')
export const graphLabelScale = (scale: number) => 2 ** (Math.round(Math.log2(scale) * 8) / 8)
const textUnits = (text: string) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 1 : .58), 0)
function shorten(text: string, maximumUnits: number): string {
  if (textUnits(text) <= maximumUnits) return text
  let result = '', units = 1
  for (const char of text) {
    units += char.charCodeAt(0) > 255 ? 1 : .58
    if (units > maximumUnits) break
    result += char
  }
  return result + '…'
}
export interface GraphNodeLabel { text: string; x: number; y: number; fontSize: number; rect: GraphRect }

/** Screen-space collision grid: selected note first, then its direct neighbours.
 * Translation is deliberately excluded, keeping labels stable while panning.
 */
export function graphSceneLabels(nodes: GraphNode[], scale: number, selected: string, connected: Set<string>) {
  const occupied = new Map<string, GraphRect[]>(), tile = 64
  const cells = (rect: GraphRect) => {
    const keys: string[] = []
    for (let x = Math.floor(rect.x / tile); x <= Math.floor((rect.x + rect.width) / tile); x++) {
      for (let y = Math.floor(rect.y / tile); y <= Math.floor((rect.y + rect.height) / tile); y++) keys.push(`${x},${y}`)
    }
    return keys
  }
  const reserve = (rect: GraphRect, grid = occupied) => { for (const key of cells(rect)) { const list = grid.get(key) || []; list.push(rect); grid.set(key, list) } }
  const free = (rect: GraphRect, grid = occupied) => cells(rect).every(key => !(grid.get(key) || []).some(other => graphRectsIntersect(rect, other)))
  const labels = new Map<string, GraphNodeLabel>()
  const font = Math.max(11, 12 * scale), worldFont = font / scale
  const dots = new Map<string, GraphRect[]>(), importantDots = new Map<string, GraphRect[]>()
  for (const node of nodes) {
    const radius = Math.max(5, (graphNodeRadius(node.note) + (node.note.path === selected ? 3 : 1)) * scale + 1)
    const rect = { x: node.x * scale - radius, y: node.y * scale - radius, width: radius * 2, height: radius * 2 }
    reserve(rect, dots)
    if (connected.has(node.note.path)) reserve(rect, importantDots)
  }
  const ordered = [...nodes].sort((a, b) => {
    const priority = (node: GraphNode) => node.note.path === selected ? 0 : connected.has(node.note.path) ? 1 : 2
    return priority(a) - priority(b) || a.note.path.localeCompare(b.note.path)
  })
  for (const node of ordered) {
    const important = connected.has(node.note.path)
    if (scale < .65 && !important) continue
    const maximum = important ? 116 : Math.min(116, 138 * scale)
    const text = shorten(graphNoteName(node.note.path), maximum / font)
    const width = textUnits(text) * font + 8, height = font * 1.3 + 4
    const x = node.x * scale, y = node.y * scale
    const gap = Math.max(5, (graphNodeRadius(node.note) + (node.note.path === selected ? 3 : 1)) * scale + 1) + 4
    const candidates = [
      { x: x - width / 2, y: y + gap, width, height },
      { x: x - width / 2, y: y - height - gap, width, height },
      { x: x + gap, y: y - height / 2, width, height },
    ]
    // Important labels can cover dimmed background dots at very low zoom, but
    // never another label or an important node's circle.
    const rect = candidates.find(rect => free(rect) && free(rect, important ? importantDots : dots))
    if (!rect) continue
    labels.set(node.note.path, { text, x: (rect.x + rect.width / 2 - x) / scale,
      y: (rect.y + font * 1.1 - y) / scale, fontSize: worldFont, rect })
    reserve(rect)
  }
  return labels
}
