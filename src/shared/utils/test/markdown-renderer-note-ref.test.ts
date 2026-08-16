import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../markdown-renderer'

describe('renderMarkdown note ref links', () => {
  it('tags internal note links with looma-note-ref and data attribute', () => {
    const html = renderMarkdown('[说明](note.md#简介)')
    expect(html).toContain('class="looma-note-ref"')
    expect(html).toContain('class="looma-link-icon looma-note-ref-icon"')
    expect(html).toContain('looma-note-ref-icon')
    // markdown-it 会 URL 编码 href，data 属性保留编码后的原文，解析层负责解码
    expect(html).toContain('data-looma-note-ref="note.md#%E7%AE%80%E4%BB%8B"')
    expect(html).not.toContain('target="_blank"')
  })

  it('keeps external links opening in new tab', () => {
    const html = renderMarkdown('[外部](https://example.com)')
    expect(html).toContain('class="looma-external-link"')
    expect(html).toContain('class="looma-link-icon looma-external-link-icon"')
    expect(html).toContain('looma-external-link-icon')
    expect(html).toContain('target="_blank"')
    expect(html).not.toContain('looma-note-ref')
  })

  it('does not tag image or bare anchor links', () => {
    expect(renderMarkdown('![图](image.png)')).not.toContain('looma-note-ref')
    expect(renderMarkdown('[锚](#标题)')).not.toContain('looma-note-ref')
  })

  it('applies a validated image width extension without rendering the attribute text', () => {
    const html = renderMarkdown('![图](image.png){width=60%}')
    expect(html).toContain('style="width: 60%; height: auto;"')
    expect(html).not.toContain('{width=60%}')
  })

  it('leaves invalid image width extensions as text', () => {
    expect(renderMarkdown('![图](image.png){width=101%}')).toContain('{width=101%}')
  })
})
