import { describe, expect, it } from 'vitest'
import { layoutKnowledgeNotes, parseGraphNote, type GraphEdge, type GraphNode } from '@/shared/utils/knowledge-graph'
import { closestGraphPoint, graphMotionEase, straightKnowledgeEdge, settleKnowledgeGraph } from '../knowledge-graph-physics'

const node = (path: string, x: number, y: number): GraphNode => ({ note: parseGraphNote(path, ''), x, y })
const edge = (source: string, target: string): GraphEdge => ({ id: JSON.stringify([source, target]), source, target, citations: [] })
describe('knowledge graph collision and motion', () => {
  it('separates crowded balls deterministically within bounded local motion', () => {
    const nodes = [node('a.md', 200, 200), node('b.md', 208, 200), node('c.md', 216, 200)]
    const layout = { nodes, width: 1200, height: 800 }
    const settled = settleKnowledgeGraph(layout, [])
    expect(settled).toEqual(settleKnowledgeGraph(layout, []))
    expect(nodes[0].x).toBe(200)
    for (let i = 0; i < nodes.length; i++) {
      expect(Math.abs(settled.nodes[i].x - nodes[i].x)).toBeLessThanOrEqual(34)
      expect(Math.abs(settled.nodes[i].y - nodes[i].y)).toBeLessThanOrEqual(18)
      for (let j = i + 1; j < nodes.length; j++) expect(Math.hypot(settled.nodes[i].x - settled.nodes[j].x, settled.nodes[i].y - settled.nodes[j].y)).toBeGreaterThan(20)
    }
  })
  it('moves an unrelated ball away while keeping its reference straight', () => {
    const nodes = [node('a.md', 100, 200), node('b.md', 500, 200), node('c.md', 300, 200)]
    const link = edge('a.md', 'b.md')
    const settled = settleKnowledgeGraph({ nodes, width: 1200, height: 800 }, [link])
    expect(Math.abs(settled.nodes[2].y - 200)).toBeGreaterThan(14)
    const route = straightKnowledgeEdge(link, new Map(settled.nodes.map(n => [n.note.path, n])))!
    const obstacle = settled.nodes[2], closest = closestGraphPoint(obstacle, route.points[0], route.points[1])
    expect(Math.hypot(obstacle.x - closest.x, obstacle.y - closest.y)).toBeGreaterThan(14)
    expect(route.points).toHaveLength(2)
    expect(Math.hypot(route.points[0].x - 100, route.points[0].y - 200)).toBeGreaterThan(10)
    expect(Math.hypot(route.points.at(-1)!.x - 500, route.points.at(-1)!.y - 200)).toBeGreaterThan(12)
  })
  it('keeps reciprocal references straight, including when another ball lies in their path', () => {
    const nodes = [node('a.md', 100, 200), node('b.md', 900, 200), ...Array.from({ length: 9 }, (_, i) => node(`${i}.md`, 180 + i * 75, 200))]
    const positions = new Map(nodes.map(n => [n.note.path, n]))
    for (const link of [edge('a.md', 'b.md'), edge('b.md', 'a.md'), edge('a.md', 'a.md')]) {
      const route = straightKnowledgeEdge(link, positions)!
      expect(route.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
      if (link.source !== link.target) {
        expect(route.points).toHaveLength(2)
        expect(route.points.every(point => point.y === 200)).toBe(true)
      }
    }
  })
  it('settles large inventories without leaving world bounds', () => {
    const notes = Array.from({ length: 1500 }, (_, i) => parseGraphNote(`日记/${i}.md`, ''))
    const layout = layoutKnowledgeNotes(notes, 1200, 800)
    const links = notes.map((n, i) => edge(n.path, notes[(i + 17) % notes.length].path))
    const settled = settleKnowledgeGraph(layout, links)
    const positions = new Map(settled.nodes.map(n => [n.note.path, n]))
    for (const link of links) expect(straightKnowledgeEdge(link, positions)).not.toBeNull()
    expect(settled.nodes.every(n => n.x > 0 && n.x < layout.width && n.y > 0 && n.y < layout.height)).toBe(true)
  })
  it('uses a monotonic finite spring and stops exactly at its destination', () => {
    expect(graphMotionEase(0)).toBe(0)
    expect(graphMotionEase(1)).toBe(1)
    for (let i = 1; i <= 100; i++) expect(graphMotionEase(i / 100)).toBeGreaterThan(graphMotionEase((i - 1) / 100))
  })
})

it('retains upward growth after local node and wire avoidance', () => {
  const notes = Array.from({ length: 60 }, (_, i) => ({ ...parseGraphNote(`dir/${i}.md`, ''), createdAt: i + 1 }))
  const packed = layoutKnowledgeNotes(notes), settled = settleKnowledgeGraph(packed, notes.slice(1).map(n => edge(notes[0].path, n.path)))
  settled.nodes.forEach((node, i) => expect(Math.abs(node.y - packed.nodes[i].y)).toBeLessThanOrEqual(18.0051))
  expect(settled.nodes[0].y).toBeGreaterThan(settled.nodes.at(-1)!.y)
})

it('leaves room for large note circles at both ends of straight references and self loops', () => {
  const a = node('a.md', 100, 100), b = node('b.md', 400, 100)
  a.note.contentLength = 20000; b.note.contentLength = 20000
  const positions = new Map([['a.md', a], ['b.md', b]])
  const route = straightKnowledgeEdge(edge('a.md', 'b.md'), positions)!
  expect(route.points[0].x - a.x).toBeGreaterThan(18)
  expect(b.x - route.points[1].x).toBeGreaterThan(18)
  const loop = straightKnowledgeEdge(edge('a.md', 'a.md'), positions)!
  expect(Math.hypot(loop.points[0].x - a.x, loop.points[0].y - a.y)).toBeGreaterThan(18)
})

it.each([[100, 100, 400, 250], [400, 250, 100, 100], [10, 20, 18, 24]])('keeps reciprocal line starts behind the opposite arrow tips for %s,%s to %s,%s', (sourceX, sourceY, targetX, targetY) => {
  const source = node('a.md', sourceX, sourceY), target = node('b.md', targetX, targetY)
  source.note.contentLength = 20000
  const positions = new Map([['a.md', source], ['b.md', target]])
  const forward = straightKnowledgeEdge(edge('a.md', 'b.md'), positions)!
  const backward = straightKnowledgeEdge(edge('b.md', 'a.md'), positions)!
  const distance = (point: { x: number; y: number }, origin: { x: number; y: number }) => Math.hypot(point.x - origin.x, point.y - origin.y)
  expect(distance(forward.points[0], source) + .00001).toBeGreaterThanOrEqual(distance(backward.points[1], source))
  expect(distance(backward.points[0], target) + .00001).toBeGreaterThanOrEqual(distance(forward.points[1], target))
  const tip = forward.headD.match(/M ([\d.-]+) ([\d.-]+)/)!
  expect(Number(tip[1])).toBeCloseTo(forward.points[1].x, 1)
  expect(Number(tip[2])).toBeCloseTo(forward.points[1].y, 1)
  expect(forward.lineD).not.toBe(forward.d)
})
