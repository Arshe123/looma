import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../markdown-renderer'

describe('renderMarkdown linkify fuzzy 关闭', () => {
  it('不识别 .md 文件名为链接', () => {
    const html = renderMarkdown('参考 Agent.md 文件')
    expect(html).not.toContain('<a')
    expect(html).toContain('Agent.md')
  })

  it('不识别裸域名 example.com 为链接', () => {
    const html = renderMarkdown('访问 example.com 查看')
    expect(html).not.toContain('<a')
    expect(html).toContain('example.com')
  })

  it('不识别 www.test.md 为链接', () => {
    const html = renderMarkdown('www.test.md')
    expect(html).not.toContain('<a')
  })

  it('仍自动链接显式 https URL', () => {
    const html = renderMarkdown('文档在 https://example.com/path')
    expect(html).toContain('href="https://example.com/path"')
  })

  it('仍自动链接 mailto', () => {
    const html = renderMarkdown('联系 user@example.com')
    expect(html).toContain('mailto:user@example.com')
  })

  it('显式 markdown 链接不受影响', () => {
    const html = renderMarkdown('[说明](note.md)')
    expect(html).toContain('href="note.md"')
  })
})

describe('renderMarkdown strong CJK 标点边界修复', () => {
  it('中文引号包裹的 bold 正常渲染', () => {
    const html = renderMarkdown('叫**“全球疫情数据分析和风险评估平台”**，也就是')
    expect(html).toContain('<strong>“全球疫情数据分析和风险评估平台”</strong>')
  })

  it('中文括号结尾的 bold 正常渲染', () => {
    const html = renderMarkdown('准确来说，**8月13日（第9天）**就是')
    expect(html).toContain('<strong>8月13日（第9天）</strong>')
  })

  it('列表项内的 CJK bold 正常渲染', () => {
    const html = renderMarkdown('- 日记里这个平台叫**“平台名”**，也就是第1天')
    expect(html).toContain('<strong>“平台名”</strong>')
  })

  it('默认能解析的 bold 不受影响', () => {
    const html = renderMarkdown('根据你的实习日记，**亚林哥是在实习第9天让你去看这个平台的测试环境的**。')
    expect(html).toContain('<strong>亚林哥是在实习第9天让你去看这个平台的测试环境的</strong>')
  })

  it('英文 bold 不受影响', () => {
    const html = renderMarkdown('This is **bold** text')
    expect(html).toContain('<strong>bold</strong>')
  })

  it('嵌套 bold 不受影响', () => {
    const html = renderMarkdown('**nested **inner** bold**')
    expect(html).toContain('<strong>')
  })

  it('italic 不受影响', () => {
    const html = renderMarkdown('*italic* text')
    expect(html).toContain('<em>italic</em>')
  })

  it('空格在 bold 内侧仍不解析（CommonMark 默认行为）', () => {
    const html = renderMarkdown('** bold ** should not match')
    expect(html).not.toContain('<strong>')
  })

  it('英文双引号包裹的 bold 正常渲染', () => {
    const html = renderMarkdown('日记里叫**"平台"**，后续')
    // markdown-it 会把 " escape 成 &quot;
    expect(html).toContain('<strong>&quot;平台&quot;</strong>')
  })

  it('英文括号包裹的 bold 正常渲染', () => {
    const html = renderMarkdown('前缀**(注释)**后缀')
    expect(html).toContain('<strong>(注释)</strong>')
  })

  it('英文句号结尾的 bold 正常渲染', () => {
    const html = renderMarkdown('前缀**bold.**后缀')
    expect(html).toContain('<strong>bold.</strong>')
  })

  it('英文逗号结尾的 bold 正常渲染', () => {
    const html = renderMarkdown('前缀**bold,**后缀')
    expect(html).toContain('<strong>bold,</strong>')
  })

  it('英文冒号结尾的 bold 正常渲染', () => {
    const html = renderMarkdown('前缀**bold:**后缀')
    expect(html).toContain('<strong>bold:</strong>')
  })
})
