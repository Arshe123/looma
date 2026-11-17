import { describe, expect, it } from 'vitest'
import { buildGraphEdges, graphNodeRadius, layoutKnowledgeNotes, parseGraphNote } from '../knowledge-graph'
import { renderMarkdown } from '../markdown-renderer'

describe('knowledge graph citations', () => {
  it('keeps heading and blockquote markers in the extracted source', () => {
    const note = parseGraphNote('source.md', '## [章节](target.md)\n\n> **说明** [目标](target.md)')
    expect(renderMarkdown(note.citations[0].snippet)).toContain('<h2>')
    expect(renderMarkdown(note.citations[1].snippet)).toContain('<blockquote>')
  })
  it('retains Markdown formatting, line breaks and reference definitions for citation previews', () => {
    const note = parseGraphNote('notes/source.md', '# Source\n\n**先读** `code`\n再看 [*目标*][target]\n\n[target]: ../目标.md#L3')
    const citation = note.citations[0]
    expect(citation.snippet).toContain('\n')
    const html = renderMarkdown(citation.snippet, { references: citation.references })
    expect(html).toContain('<strong>先读</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<em>目标</em>')
    expect(html).toContain('<br>')
    expect(html).toContain('looma-note-ref')
  })
  it('resolves inline, reference-style and legacy space links, keeping anchors and source context', () => {
    const note = parseGraphNote('设计/源.md', '# **设计**笔记\n\n参见 [目标](../知识/目标%20笔记.md#L12) 和 [再读][r]。\n\n[r]: ../知识/目标%20笔记.md#定义\n\n[旧链接](../知识/目标 笔记.md)')
    expect(note.title).toBe('设计笔记')
    expect(note.citations.map(c => c.target)).toEqual(Array(3).fill('知识/目标 笔记.md'))
    expect(note.citations[0]).toMatchObject({ line: 3, anchor: { kind: 'line', line: 12 } })
    expect(note.citations[1].anchor).toEqual({ kind: 'heading', text: '定义' })
    expect(note.citations[0].snippet).toContain('参见')
    const result = buildGraphEdges([note, parseGraphNote('知识/目标 笔记.md', '')])
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0].citations).toHaveLength(3)
  })

  it('excludes images, code, external URLs, page anchors and links escaping the workspace', () => {
    const source = ['![image](target.md)', '`[code](target.md)`', '```md\n[code](target.md)\n```',
      '[web](https://example.com/a.md) [custom](app:target.md) [local](#heading)',
      '[escape](../../target.md) [absolute](/target.md)', '\\[escaped](target.md)', '[real](target.md)'].join('\n\n')
    const note = parseGraphNote('dir/note.md', source)
    expect(note.citations.map(c => c.target)).toEqual(['dir/target.md'])
    expect(parseGraphNote('note.txt', '[plain](target.md)').citations).toEqual([])
  })

  it('retains isolated notes, missing targets, directed cycles and self references', () => {
    const notes = [parseGraphNote('a.md', '[b](b.md) [self](a.md) [gone](gone.md)'), parseGraphNote('b.md', '[a](a.md)'), parseGraphNote('alone.md', '')]
    const { edges, missing } = buildGraphEdges(notes)
    expect(edges.map(e => [e.source, e.target])).toEqual([['a.md', 'b.md'], ['a.md', 'a.md'], ['b.md', 'a.md']])
    expect(missing.get('a.md')?.[0].target).toBe('gone.md')
    expect(layoutKnowledgeNotes(notes).nodes).toHaveLength(3)
  })
})

describe('tree knowledge note layout', () => {
  it('shows all nested notes without directory decorations, including duplicate filenames', () => {
    const notes = ['项目/a.md', '项目/子目录/b.md', '其他/a.md', '根笔记.md'].map(path => parseGraphNote(path, ''))
    const layout = layoutKnowledgeNotes(notes)
    expect(new Set(layout.nodes.map(node => node.note.path)).size).toBe(4)
    expect(layoutKnowledgeNotes([...notes].reverse())).toEqual(layout)
    expect(layout.nodes.every(node => node.x > 34 && node.x < layout.width - 34 && node.y > 18 && node.y < layout.height - 18)).toBe(true)
  })
  it('spreads a large inventory in two dimensions while retaining room for collision motion', () => {
    const notes = Array.from({ length: 1500 }, (_, index) => parseGraphNote(`目录/${index}.md`, ''))
    const layout = layoutKnowledgeNotes(notes)
    expect(layout.nodes).toHaveLength(1500)
    expect(layout.width / layout.height).toBeGreaterThanOrEqual(1)
    expect(layout.width / layout.height).toBeLessThan(2)
    expect(new Set(layout.nodes.map(node => node.x)).size).toBeGreaterThan(20)
    expect(new Set(layout.nodes.map(node => node.y)).size).toBeGreaterThan(20)
    expect(layoutKnowledgeNotes([]).nodes).toEqual([])
  })
})

it('sizes Markdown and text notes by non-whitespace content with bounded monotonic radii', () => {
  const small = parseGraphNote('small.md', 'abc'), medium = parseGraphNote('medium.txt', 'x'.repeat(2000)), large = parseGraphNote('large.md', 'x'.repeat(20000))
  expect(small.contentLength).toBe(3)
  expect(parseGraphNote('spaces.txt', ' a \n b ').contentLength).toBe(2)
  expect(graphNodeRadius({})).toBe(6)
  expect(graphNodeRadius(small)).toBeLessThan(graphNodeRadius(medium))
  expect(graphNodeRadius(medium)).toBeLessThan(graphNodeRadius(large))
  expect(graphNodeRadius(large)).toBe(18)
  expect(graphNodeRadius({ contentLength: Infinity })).toBe(6)
})

it('grows older notes from the bottom and places nested folders in neighbouring branches', () => {
  const paths = ['root.md', 'a/old.md', 'a/new.md', 'a/sub/note.md', 'b/note.md']
  const notes = paths.map((path, i) => ({ ...parseGraphNote(path, ''), createdAt: i + 1 }))
  const layout = layoutKnowledgeNotes(notes.reverse()), positions = new Map(layout.nodes.map(node => [node.note.path, node]))
  expect(positions.get('root.md')!.y).toBeGreaterThan(positions.get('a/old.md')!.y)
  expect(positions.get('a/old.md')!.y).toBeGreaterThan(positions.get('a/new.md')!.y)
  expect(positions.get('a/new.md')!.y).toBeGreaterThan(positions.get('a/sub/note.md')!.y)
  expect(positions.get('a/sub/note.md')!.x).toBeLessThan(positions.get('b/note.md')!.x)
  expect(layoutKnowledgeNotes([...notes].reverse())).toEqual(layout)
})

it('rounds the crown above a narrow trunk and attaches subdirectories along its shoulders', () => {
  const notes = Array.from({ length: 100 }, (_, index) => ({ ...parseGraphNote(`tree/${index}.md`, ''), createdAt: index + 1 }))
  const children = Array.from({ length: 24 }, (_, index) => ({ ...parseGraphNote(`tree/twig/${index}.md`, ''), createdAt: index + 101 }))
  const layout = layoutKnowledgeNotes([...notes, ...children])
  const trunk = layout.nodes.filter(node => !node.note.path.includes('/twig/'))
  const bottom = Math.max(...trunk.map(node => node.y))
  const rows = new Map<number, number>()
  for (const node of trunk) {
    const row = Math.round((bottom - node.y) / 58)
    rows.set(row, (rows.get(row) || 0) + 1)
  }
  expect(rows.get(0)).toBe(1)
  expect(rows.get(Math.max(...rows.keys()))).toBeLessThan(Math.max(...rows.values()))
  const twig = layout.nodes.filter(node => node.note.path.includes('/twig/'))
  expect(Math.max(...twig.map(node => node.y))).toBeGreaterThan(Math.min(...trunk.map(node => node.y)))
  expect(Math.abs(twig[0].x - trunk[0].x)).toBeGreaterThan(60)
  expect(layoutKnowledgeNotes([...notes, ...children].reverse())).toEqual(layout)
})

it('keeps small crowns finite with every note represented', () => {
  for (let count = 0; count <= 20; count++) {
    const layout = layoutKnowledgeNotes(Array.from({ length: count }, (_, index) => parseGraphNote(`tree/${index}.md`, '')))
    expect(layout.nodes).toHaveLength(count)
    expect(layout.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)
  }
})

it('keeps sparse single-child trunks connected instead of jumping sideways', () => {
  const paths = ['root.md', 'tree/trunk.md', ...Array.from({ length: 60 }, (_, index) => `tree/crown/${index}.md`)]
  const layout = layoutKnowledgeNotes(paths.map((path, index) => ({ ...parseGraphNote(path, ''), createdAt: index + 1 })))
  const root = layout.nodes.find(node => node.note.path === 'root.md')!
  const trunk = layout.nodes.find(node => node.note.path === 'tree/trunk.md')!
  const crownBase = layout.nodes.find(node => node.note.path === 'tree/crown/0.md')!
  expect(Math.abs(root.x - trunk.x)).toBeLessThan(30)
  expect(Math.abs(trunk.x - crownBase.x)).toBeLessThan(30)
  expect(root.y).toBeGreaterThan(trunk.y)
  expect(trunk.y).toBeGreaterThan(crownBase.y)
})
