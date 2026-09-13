import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

describe('note-only title styling and integration', () => {
  it('opts both note renderers into the shared title appearance and keeps metadata in the title chunk cache key', () => {
    const rich = read('../../../renderer/components/preview/TiptapPreview.vue')
    const chunked = read('../../../renderer/components/preview/ChunkedMarkdownPreview.vue')
    for (const component of [rich, chunked]) {
      expect(component).toContain("import '@/renderer/styles/note-title.css'")
      expect(component).toContain('looma-note-body')
    }
    expect(rich).toMatch(/LineNumbers,\s+NoteTitle,/)
    expect(chunked).toContain('getMarkdownNoteTitleMetadata(props.content, props.isPartial)')
    expect(chunked).toContain('JSON.stringify(noteTitle)')
    expect(chunked).toContain('renderMarkdownWithLineData(chunk.content, chunk.startLine, noteTitle)')
  })
  it('removes only note H1 borders, leaves level markers alone and resets immediately following margins across chunks', () => {
    const css = read('../../../renderer/styles/note-title.css')
    expect(css).toMatch(/\.markdown-body\.looma-note-body h1\s*\{[^}]*border-bottom:\s*0/s)
    expect(css).not.toContain('::after')
    expect(css).toContain('.looma-note-reading-time + *')
    expect(css).toContain(':has(> .looma-note-reading-time:last-child) + .markdown-render-chunk > :first-child')
    expect(css).toContain('user-select: none')
  })
})
