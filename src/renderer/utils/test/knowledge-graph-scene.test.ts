import { describe, expect, it } from 'vitest'
import { straightKnowledgeEdge } from '../knowledge-graph-physics'
import { buildGraphEdges, layoutKnowledgeNotes, parseGraphNote } from '@/shared/utils/knowledge-graph'
import { GraphNodeIndex, graphAdjacency, graphDirectoryHue, graphInteractionEdges, graphLabelScale, graphRectsIntersect, graphRectFromKey, graphRenderWindowKey, graphSceneLabels } from '../knowledge-graph-scene'

describe('graph viewport scene', () => {
  it('keeps directory hues stable across filenames and related folders in the same colour family', () => {
    expect(graphDirectoryHue('设计/a.md')).toBe(graphDirectoryHue('设计/b.md'))
    expect(graphDirectoryHue('设计/体验/a.md')).toBe(graphDirectoryHue('设计\\体验\\b.md'))
    expect(graphDirectoryHue('设计/a.md')).not.toBe(graphDirectoryHue('知识方法/a.md'))
    const difference = Math.abs(graphDirectoryHue('设计/体验/a.md') - graphDirectoryHue('设计/a.md'))
    expect(Math.min(difference, 360 - difference)).toBeLessThanOrEqual(22)
    expect(graphDirectoryHue('root.md')).toBe(graphDirectoryHue('other.txt'))
  })
  it('previews only the hovered node relationships, then restores the selection on leave', () => {
    const notes = [parseGraphNote('a.md', '[b](b.md) [self](a.md)'), parseGraphNote('b.md', '[c](c.md)'), parseGraphNote('c.md', '')]
    const { edges } = buildGraphEdges(notes), adjacency = graphAdjacency(edges)
    expect(graphInteractionEdges(adjacency, '', 'b.md').map(edge => [edge.source, edge.target])).toEqual([['a.md', 'b.md'], ['b.md', 'c.md']])
    expect(graphInteractionEdges(adjacency, 'a.md', 'b.md')).toEqual(adjacency.get('b.md'))
    expect(graphInteractionEdges(adjacency, 'a.md', 'missing.md')).toEqual([])
    expect(graphInteractionEdges(adjacency, 'a.md', '')).toEqual(adjacency.get('a.md'))
    expect(graphInteractionEdges(adjacency, '', '')).toEqual([])
  })
  const notes = Array.from({ length: 1000 }, (_, i) => parseGraphNote(`日记/第${i}天.md`, '# 上午'))
  const layout = layoutKnowledgeNotes(notes, 1200, 800)
  it('indexes only nearby nodes, including negative coordinates and empty distant viewports', () => {
    const index = new GraphNodeIndex(layout.nodes)
    const rect = { x: layout.width / 2 - 300, y: layout.height / 2 - 200, width: 600, height: 400 }
    const visible = index.query(rect)
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(100)
    expect(new Set(visible.map(node => node.note.path)).size).toBe(visible.length)
    expect(visible.map(node => node.note.path).sort()).toEqual(layout.nodes.filter(n => n.x >= rect.x && n.x <= rect.x + rect.width && n.y >= rect.y && n.y <= rect.y + rect.height).map(n => n.note.path).sort())
    expect(index.query({ x: -1000, y: -1000, width: 10, height: 10 })).toEqual([])
    expect(index.query({ x: -1e6, y: -1e6, width: 2e6, height: 2e6 })).toHaveLength(1000)
  })
  it('reuses the same overscan window for small camera movements', () => {
    const size = { width: 600, height: 400 }, camera = { x: 0, y: 0, scale: 1 }
    expect(graphRenderWindowKey(camera, size)).toBe(graphRenderWindowKey({ ...camera, x: 1 }, size))
    const rect = graphRectFromKey(graphRenderWindowKey(camera, size))
    expect(rect.x).toBeLessThan(-90)
    expect(rect.x + rect.width).toBeGreaterThan(size.width + 90)
    expect(graphLabelScale(1)).toBe(graphLabelScale(1.01))
  })
  it.each([.1, .25, .5, .7, 1, 2])('keeps labels collision-free at scale %s, showing filenames rather than repeated headings', scale => {
    const selected = layout.nodes[12].note.path
    const connected = new Set([selected, layout.nodes[13].note.path])
    const labels = graphSceneLabels(layout.nodes.slice(0, 120), scale, selected, connected)
    expect(labels.has(selected)).toBe(true)
    expect(labels.get(selected)?.text).toContain('第')
    const node = layout.nodes[12], radius = 9 * scale
    expect(graphRectsIntersect(labels.get(selected)!.rect, { x: node.x * scale - radius, y: node.y * scale - radius, width: radius * 2, height: radius * 2 })).toBe(false)
    expect([...labels.values()].some(label => label.text.includes('上午'))).toBe(false)
    if (scale < .65) expect(labels.size).toBeLessThanOrEqual(2)
    const rects = [...labels.values()].map(label => label.rect)
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(graphRectsIntersect(rects[i], rects[j])).toBe(false)
  })
  it('omits ordinary labels in overview but retains every dot in the model', () => {
    const labels = graphSceneLabels(layout.nodes, .4, '', new Set())
    expect(labels.size).toBe(0)
    expect(layout.nodes).toHaveLength(1000)
  })
  it('indexes direct references once and keeps crossing references even when both endpoints are outside the viewport', () => {
    const notes = [parseGraphNote('a.md', '[b](b.md) [self](a.md)'), parseGraphNote('b.md', '[a](a.md)'), parseGraphNote('alone.md', '')]
    const { edges } = buildGraphEdges(notes), adjacency = graphAdjacency(edges)
    expect(adjacency.get('a.md')).toHaveLength(3)
    expect(adjacency.get('b.md')).toHaveLength(2)
    expect(adjacency.has('alone.md')).toBe(false)
    const positions = new Map(notes.map((note, index) => [note.path, { note, x: index * 1000 - 500, y: 100 }]))
    const geometry = straightKnowledgeEdge(edges[0], positions)!
    expect(graphRectsIntersect(geometry.bounds, { x: -100, y: 0, width: 200, height: 200 })).toBe(true)
    expect(straightKnowledgeEdge(edges[0], new Map())).toBe(null)
    expect(straightKnowledgeEdge(edges[1], positions)?.d).not.toMatch(/NaN|Infinity/)
  })
})
