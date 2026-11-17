import { graphNodeRadius } from '@/shared/utils/knowledge-graph'
import type { GraphEdge, GraphLayout, GraphNode } from '@/shared/utils/knowledge-graph'

export interface GraphPoint { x: number; y: number }
const distance = (a: GraphPoint, b: GraphPoint) => Math.hypot(a.x - b.x, a.y - b.y)
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const hash = (text: string) => { let result = 2166136261; for (const char of text) result = Math.imul(result ^ char.charCodeAt(0), 16777619); return result >>> 0 }
export function closestGraphPoint(point: GraphPoint, a: GraphPoint, b: GraphPoint): GraphPoint {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1)
  return { x: a.x + t * dx, y: a.y + t * dy }
}

/** Fine collision grid, independent of the coarser viewport rendering index. */
class GraphCollisionIndex {
  private cells = new Map<string, GraphNode[]>()
  constructor(nodes: GraphNode[], private cell = 96) {
    for (const node of nodes) {
      const key = `${Math.floor(node.x / cell)},${Math.floor(node.y / cell)}`
      const list = this.cells.get(key) || []
      list.push(node); this.cells.set(key, list)
    }
  }
  near(point: GraphPoint, radius: number): GraphNode[] {
    const result: GraphNode[] = []
    for (let x = Math.floor((point.x - radius) / this.cell); x <= Math.floor((point.x + radius) / this.cell); x++) {
      for (let y = Math.floor((point.y - radius) / this.cell); y <= Math.floor((point.y + radius) / this.cell); y++) result.push(...this.cells.get(`${x},${y}`) || [])
    }
    return result
  }

}

/** A bounded damped relaxation, run only when graph topology or packing changes.
 * Anchors prevent global drift; no idle simulation runs.
 */
export function settleKnowledgeGraph(layout: GraphLayout, edges: GraphEdge[]): GraphLayout {
  if (!layout.nodes.length) return layout
  const nodes = layout.nodes.map(node => ({ ...node })), original = layout.nodes
  const byPath = new Map(nodes.map((node, index) => [node.note.path, index]))
  const separation = 44
  const velocities = nodes.map(() => ({ x: 0, y: 0 }))
  const links = edges.flatMap(edge => {
    const a = byPath.get(edge.source), b = byPath.get(edge.target)
    return a !== undefined && b !== undefined && a !== b ? [{ a, b, edge }] : []
  })
  // Rasterize wire corridors once; the 96px neighbour margin contains every
  // permitted local displacement, so subsequent iterations reuse this index.
  const wireCells = new Map<string, Set<number>>()
  links.forEach((link, index) => {
    const a = nodes[link.a], b = nodes[link.b], steps = Math.max(1, Math.ceil(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 96))
    for (let step = 0; step <= steps; step++) {
      const t = step / steps, key = `${Math.floor((a.x + (b.x - a.x) * t) / 96)},${Math.floor((a.y + (b.y - a.y) * t) / 96)}`
      const list = wireCells.get(key) || new Set<number>()
      list.add(index); wireCells.set(key, list)
    }
  })
  for (let i = 0; i < nodes.length; i++) {
    const seed = hash(nodes[i].note.path)
    nodes[i].x += (seed % 101 / 100 - .5) * 8
    nodes[i].y += ((seed >>> 8) % 101 / 100 - .5) * 5
  }
  for (let iteration = 0; iteration < 28; iteration++) {
    const index = new GraphCollisionIndex(nodes)
    const forces = nodes.map((node, i) => ({ x: (original[i].x - node.x) * .1, y: (original[i].y - node.y) * .1 }))
    nodes.forEach((node, i) => {
      for (const other of index.near(node, 48)) {
        const j = byPath.get(other.note.path)!
        if (j <= i) continue
        let dx = node.x - other.x, dy = node.y - other.y, length = Math.hypot(dx, dy)
        const clearance = Math.max(separation, graphNodeRadius(node.note) + graphNodeRadius(other.note) + 10)
        if (length >= clearance) continue
        if (length < .01) { const angle = hash(node.note.path + other.note.path) / 0xffffffff * Math.PI * 2; dx = Math.cos(angle); dy = Math.sin(angle); length = 1 }
        const strength = (clearance - length) * (length < 30 ? .65 : .09)
        forces[i].x += dx / length * strength; forces[i].y += dy / length * strength
        forces[j].x -= dx / length * strength; forces[j].y -= dy / length * strength
      }
      const candidates = new Set<number>(), cellX = Math.floor(node.x / 96), cellY = Math.floor(node.y / 96)
      for (let x = cellX - 1; x <= cellX + 1; x++) for (let y = cellY - 1; y <= cellY + 1; y++) for (const link of wireCells.get(`${x},${y}`) || []) candidates.add(link)
      for (const candidate of candidates) {
        const link = links[candidate]
        if (link.a === i || link.b === i) continue
        const a = nodes[link.a], b = nodes[link.b], closest = closestGraphPoint(node, a, b)
        let dx = node.x - closest.x, dy = node.y - closest.y, length = Math.hypot(dx, dy)
        const clearance = graphNodeRadius(node.note) + 18
        if (length >= clearance) continue
        if (length < .01) { const side = hash(node.note.path + link.edge.id) % 2 ? 1 : -1; dx = -(b.y - a.y) * side; dy = (b.x - a.x) * side; length = Math.hypot(dx, dy) || 1 }
        const strength = (clearance - Math.min(clearance, distance(node, closest))) * .85
        forces[i].x += dx / length * strength; forces[i].y += dy / length * strength
      }
    })
    let movement = 0
    nodes.forEach((node, i) => {
      const anchor = original[i]
      const velocity = velocities[i]
      velocity.x = (velocity.x + forces[i].x) * .58; velocity.y = (velocity.y + forces[i].y) * .58
      const x = clamp(node.x + clamp(velocity.x, -5, 5), Math.max(anchor.x - 34, 12), Math.min(anchor.x + 34, layout.width - 12))
      const y = clamp(node.y + clamp(velocity.y, -4, 4), Math.max(anchor.y - 18, 12), Math.min(anchor.y + 18, layout.height - 12))
      movement = Math.max(movement, Math.abs(x - node.x) + Math.abs(y - node.y))
      node.x = x; node.y = y
    })
    if (iteration > 8 && movement < .025) break
  }
  return { ...layout, nodes: nodes.map(node => ({ ...node, x: Math.round(node.x * 100) / 100, y: Math.round(node.y * 100) / 100 })) }
}

interface GraphEdgeGeometry {
  edge: GraphEdge; points: GraphPoint[]; d: string; lineD: string; headD: string
  bounds: { x: number; y: number; width: number; height: number }
}
const graphPointsPath = (points: GraphPoint[]) => points.map((point, index) => `${index ? 'L' : 'M'} ${Math.round(point.x * 100) / 100} ${Math.round(point.y * 100) / 100}`).join(' ')
function graphArrowPaths(points: GraphPoint[]): { lineD: string; headD: string } {
  const tip = points[points.length - 1]
  const previous = points[points.length - 2]
  const length = distance(previous, tip)
  if (length < .001) return { lineD: graphPointsPath(points), headD: '' }
  const arrowLength = Math.min(8.4, length * .8)
  const directionX = (tip.x - previous.x) / length, directionY = (tip.y - previous.y) / length
  const base = { x: tip.x - directionX * arrowLength, y: tip.y - directionY * arrowLength }
  const halfWidth = arrowLength * .5
  return {
    lineD: graphPointsPath([...points.slice(0, -1), base]),
    headD: graphPointsPath([tip,
      { x: base.x - directionY * halfWidth, y: base.y + directionX * halfWidth },
      { x: base.x + directionY * halfWidth, y: base.y - directionX * halfWidth },
    ]) + ' Z',
  }
}
/** Keep references straight: only the balls respond to wire collisions.
 * Self references use a small loop because their endpoints are the same ball.
 */
export function straightKnowledgeEdge(edge: GraphEdge, positions: Map<string, GraphNode>): GraphEdgeGeometry | null {
  const source = positions.get(edge.source), target = positions.get(edge.target)
  if (!source || !target) return null
  let points: GraphPoint[]
  if (source === target) {
    const loopScale = (graphNodeRadius(source.note) + 8) / 14
    points = [[-6, -12], [-24, -22], [-24, -44], [0, -54], [24, -44], [24, -22], [6, -14]]
      .map(([x, y]) => ({ x: source.x + x * loopScale, y: source.y + y * loopScale }))
  } else {
    const length = distance(source, target), dx = (target.x - source.x) / (length || 1), dy = (target.y - source.y) / (length || 1)
    const startGap = Math.min(graphNodeRadius(source.note) + 10, length * .4), endGap = Math.min(graphNodeRadius(target.note) + 8, length * .4)
    points = [{ x: source.x + dx * startGap, y: source.y + dy * startGap }, { x: target.x - dx * endGap, y: target.y - dy * endGap }]
  }
  const xs = points.map(point => point.x), ys = points.map(point => point.y), x = Math.min(...xs) - 8, y = Math.min(...ys) - 8
  return { edge, points, d: graphPointsPath(points), ...graphArrowPaths(points), bounds: { x, y, width: Math.max(...xs) + 8 - x, height: Math.max(...ys) + 8 - y } }
}

/** Critically damped spring: smooth motion that comes to rest, without idle drift. */
export function graphMotionEase(progress: number): number {
  const t = clamp(progress, 0, 1)
  return (1 - (1 + 8 * t) * Math.exp(-8 * t)) / (1 - 9 * Math.exp(-8))
}
