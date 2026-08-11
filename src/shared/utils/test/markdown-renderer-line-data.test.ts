import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownWithLineData } from '../markdown-renderer'

describe('renderMarkdownWithLineData', () => {
  it('在块元素上注入绝对源码行号（data-line）', () => {
    const html = renderMarkdownWithLineData('# 标题\n\n正文一\n\n正文二', 7)
    expect(html).toContain('<h1 data-line="8">')
    expect(html).toContain('<p data-line="10">')
    expect(html).toContain('<p data-line="12">')
  })

  it('列表项带行号（紧凑列表的 li），引用块内段落带行号，容器不带', () => {
    const html = renderMarkdownWithLineData('- 项一\n- 项二\n\n> 引用', 0)
    expect(html).toContain('<li data-line="1">')
    expect(html).toContain('<li data-line="2">')
    expect(html).toContain('<p data-line="4">')
    expect(html).not.toContain('<ul data-line=')
    expect(html).not.toContain('<blockquote data-line=')
  })

  it('代码块内容逐行带行号（fence 行 +1 起）', () => {
    const html = renderMarkdownWithLineData('前文\n\n```py\nx\ny\n```', 0)
    expect(html).toContain('data-line="4"')
    expect(html).toContain('data-line="5"')
    expect(html).not.toContain('data-line="3"')
  })

  it('表格内部不注入行号', () => {
    const html = renderMarkdownWithLineData('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n尾部', 0)
    expect(html).not.toContain('<td data-line=')
    expect(html).not.toContain('<th data-line=')
    expect(html).toContain('<p data-line="5">')
  })

  it('不带 lineBase 时与 renderMarkdown 输出一致（无 data-line）', () => {
    const content = '# 标题\n\n段落[链接](note.md)'
    expect(renderMarkdown(content)).not.toContain('data-line')
    expect(renderMarkdownWithLineData(content, 0)).toContain('data-line=')
  })
})
