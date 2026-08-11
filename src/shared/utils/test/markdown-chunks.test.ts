import { describe, expect, it } from 'vitest'
import {
  splitMarkdownIntoRenderChunks,
  splitMarkdownIntoRenderChunksWithLines,
} from '../markdown-chunks'

describe('splitMarkdownIntoRenderChunks', () => {
  it('splits at Markdown block boundaries', () => {
    const content = 'first paragraph\n\nsecond paragraph\n\nthird paragraph\n'
    const chunks = splitMarkdownIntoRenderChunks(content, 18)

    expect(chunks.join('')).toBe(content)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.slice(0, -1).every(chunk => chunk.endsWith('\n\n'))).toBe(true)
  })

  it('does not split inside fenced code blocks', () => {
    const content = ['before', '', '```ts', 'const a = 1', '', 'const b = 2', '```', '', 'after'].join('\n')
    const chunks = splitMarkdownIntoRenderChunks(content, 10)

    expect(chunks.join('')).toBe(content)
    const fencedChunk = chunks.find(chunk => chunk.includes('```ts'))
    expect(fencedChunk).toContain('const b = 2')
    expect(fencedChunk?.match(/```/g)).toHaveLength(2)
  })

  it('records the zero-based source line where every render chunk starts', () => {
    const content = 'first\n\nsecond\n\nthird\n'
    const chunks = splitMarkdownIntoRenderChunksWithLines(content, 6)

    expect(chunks.map(chunk => ({ content: chunk.content, startLine: chunk.startLine }))).toEqual([
      { content: 'first\n\n', startLine: 0 },
      { content: 'second\n\n', startLine: 2 },
      { content: 'third\n', startLine: 4 },
    ])
    expect(chunks.map(chunk => chunk.content).join('')).toBe(content)
  })
})
