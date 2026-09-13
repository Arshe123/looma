import { describe, expect, it } from 'vitest'
import * as renderer from '../markdown-renderer'
import { splitMarkdownIntoRenderChunksWithLines } from '../markdown-chunks'

describe('opt-in whole-note title rendering', () => {
  it('injects only the globally eligible heading while preserving source lines and default callers', () => {
    const source = '\n# Title\n\n## Section\n\n' + 'word '.repeat(201) + '\n\n# Later'
    const metadata = renderer.getMarkdownNoteTitleMetadata(source, false)
    expect(metadata).toEqual({ line: 1, minutes: 2 })
    expect(renderer.renderMarkdown(source)).not.toContain('looma-note-reading-time')
    expect(renderer.renderMarkdownWithLineData(source, 0)).not.toContain('looma-note-reading-time')
    const html = splitMarkdownIntoRenderChunksWithLines(source, 10).map(chunk => renderer.renderMarkdownWithLineData(chunk.content, chunk.startLine, metadata)).join('')
    expect(html.match(/class="looma-note-reading-time"/g)).toHaveLength(1)
    expect(html).toContain('预计阅读 2 分钟')
    expect(html).toMatch(/<h1[^>]*data-line="2"[^>]*>Title<\/h1>\n<div class="looma-note-reading-time">/)
    expect(html).not.toMatch(/class="looma-note-reading-time"[^>]*data-line/)
  })
  it('does not invent a title and distinguishes partial status from final minutes', () => {
    expect(renderer.getMarkdownNoteTitleMetadata('body\n\n# Later', false)).toBeNull()
    const pending = renderer.getMarkdownNoteTitleMetadata('# Title', true)
    expect(pending).toEqual({ line: 0, minutes: null })
    expect(renderer.renderMarkdownWithLineData('# Title', 0, pending)).toContain('阅读时间待全文加载')
    expect(renderer.getMarkdownNoteTitleMetadata('# Title\n\n' + '中'.repeat(900), false)).toEqual({ line: 0, minutes: 3 })
  })
})
