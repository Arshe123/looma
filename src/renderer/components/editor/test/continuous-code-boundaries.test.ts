import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { buildContinuousCodeDecorations, buildContinuousCodePlan } from '../continuousMarkdownCode'
import { parsedMarkdownState } from './parsed-markdown-state'

const state = (doc: string) => parsedMarkdownState(EditorState.create({ doc, extensions: [markdown()] }))
function lines(s: EditorState, from = 0, to = s.doc.length) {
  const result: { line: number; classes: string; block: string }[] = []
  buildContinuousCodeDecorations(s, [{ from, to }], false).between(0, s.doc.length, (at, _to, decoration) => {
    if (decoration.spec.attributes?.['data-code-line']) result.push({
      line: s.doc.lineAt(at).number,
      classes: decoration.spec.class,
      block: decoration.spec.attributes['data-code-block'],
    })
  })
  return result
}

describe('continuous indented code shell boundaries', () => {
  it.skipIf(!process.env.LOOMA_CODE_BOUNDARY_FIXTURE)('preserves the read-only real reproduction and decorates its three known indented boundaries', () => {
    const path = process.env.LOOMA_CODE_BOUNDARY_FIXTURE!
    const bytes = readFileSync(path)
    const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
    let s = state(bytes.toString('utf8'))
    // Fixture setup only: production continues to consume the bounded available tree.
    expect(ensureSyntaxTree(s, s.doc.length, 1000)).not.toBeNull()
    s = s.update({}).state // Publish the prepared parser context, as the view worker does.
    for (const [first, last] of [[56, 120], [124, 127], [135, 167]]) {
      const shell = lines(s, s.doc.line(first).from, s.doc.line(last).to)
      expect(shell[0]?.line).toBe(first)
      expect(shell.at(-1)?.line).toBe(last)
      expect(shell[0]?.classes).toContain('looma-code-block-start')
      expect(shell.at(-1)?.classes).toContain('looma-code-block-end')
    }
    expect(hash(s.doc.toString())).toBe(hash(bytes))
    expect(hash(readFileSync(path))).toBe(hash(bytes))
  })
  it('reserves shell borders for identified native code lines, with head/tail breathing room for non-fence content', () => {
    const css = readFileSync(new URL('../../shared/code-block-presentation.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.cm-line\.looma-code-line\.looma-continuous-code-block\s*\{[^}]*border-inline:/s)
    expect(css).toMatch(/\.looma-code-block-start:not\(\.looma-code-fence-start\)\s*\{[^}]*padding-top: 0\.85rem/s)
    expect(css).toMatch(/\.looma-code-block-end:not\(\.looma-code-fence-end\)\s*\{[^}]*padding-bottom: 0\.85rem/s)
  })

  it('keeps offscreen caps off the viewport edges and adjacent blocks distinct', () => {
    const s = state('before\n\n    a\n    b\n    c\n    d\n\nafter\n\n    e\n    f')
    const middle = lines(s, s.doc.line(4).from, s.doc.line(5).to)
    expect(middle.map(line => line.line)).toEqual([4, 5])
    expect(middle.every(line => !/looma-code-block-(?:start|end)/.test(line.classes))).toBe(true)
    const tailAndNext = lines(s, s.doc.line(6).from, s.doc.length)
    expect(tailAndNext.map(line => line.line)).toEqual([6, 10, 11])
    expect(tailAndNext[0].classes).toContain('looma-code-block-end')
    expect(tailAndNext[1].classes).toContain('looma-code-block-start')
    expect(tailAndNext[0].block).not.toBe(tailAndNext[1].block)
  })
  it('caps standard four-space code at its real first and last lines without requiring an opening fence', () => {
    const source = 'before\n\n    alpha\n\n    beta\nafter'
    const s = state(source)
    const plan = buildContinuousCodePlan(s, [{ from: 0, to: s.doc.length }])
    expect(plan.blocks).toHaveLength(1)
    expect(plan.blocks[0].opening).toBeNull()
    expect(plan.blocks[0].from).toBeGreaterThan(s.doc.line(3).from) // AST starts after indentation.
    const shell = lines(s)
    expect(shell.map(line => line.line)).toEqual([3, 4, 5])
    expect(shell[0].classes).toContain('looma-code-block-start')
    expect(shell[2].classes).toContain('looma-code-block-end')
    expect(shell.every(line => !line.classes.includes('looma-code-fence-'))).toBe(true)
    expect(s.doc.toString()).toBe(source)
  })
})
