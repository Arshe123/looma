import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownWithLineData } from '../markdown-renderer'
import { getInlineMarkdownSpans } from '../tiptap-inline-markdown'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { InlineMarkdown } from '../tiptap-inline-markdown'
import '../markdown-rich-text'
import { getCodeHighlightSegments } from '../markdown-code-highlight'

describe('AI and rich-text inline Markdown grammar', () => {
  it('renders nested formatting inside highlights in both reading paths', () => {
    const source = '前 ==**重点**与 `代码`== 后'
    expect(getInlineMarkdownSpans(source).map(span => span.type)).toEqual(['highlight', 'bold', 'inlineCode'])
    for (const html of [renderMarkdown(source), renderMarkdownWithLineData(source, 8)]) {
      expect(html).toContain('<mark><strong>重点</strong>与 <code>代码</code></mark>')
    }
  })

  it.each([
    ['中文**“重点 `命令`”**后文', ['bold', 'inlineCode'], '<strong>“重点 <code>命令</code>”</strong>'],
    ['中文**🚨重点**后文', ['bold'], '<strong>🚨重点</strong>'],
    ['中文**重点🚨**后文', ['bold'], '<strong>重点🚨</strong>'],
    ['==*斜体*与 ~~删除~~==', ['highlight', 'italic', 'strike'], '<mark><em>斜体</em>与 <s>删除</s></mark>'],
    ['**“==高亮==”**', ['bold', 'highlight'], '<strong>“<mark>高亮</mark>”</strong>'],
    ['***粗斜体***', ['italic', 'bold'], '<em><strong>粗斜体</strong></em>'],
    ['`==不高亮== **不加粗**`', ['inlineCode'], '<code>==不高亮== **不加粗**</code>'],
    ['==未闭合', [], '==未闭合'],
    ['==a=b==', [], '==a=b=='],
    ['** 空白。**', [], '** 空白。**'],
    ['**“空白 **', [], '**“空白 **'],
  ])('keeps AI, preview and source-backed editor semantics aligned: %s', (source, types, fragment) => {
    expect(getInlineMarkdownSpans(source).map(span => span.type)).toEqual(types)
    for (const html of [renderMarkdown(source), renderMarkdownWithLineData(source, 20)]) {
      expect(html).toContain(fragment)
    }
    const manager = new MarkdownManager({ extensions: [StarterKit, InlineMarkdown] })
    expect(manager.serialize(manager.parse(source)).trimEnd()).toBe(source)
  })

  it('keeps reference resolution and source line anchors inside nested formatting', () => {
    const html = renderMarkdownWithLineData('==[**笔记**][ref]==\n\n[ref]: note.md#L2', 5)
    expect(html).toContain('data-line="6"')
    expect(html).toContain('href="note.md#L2"')
    expect(html).toContain('<strong>笔记</strong></a></mark>')
  })

  it('does not activate HTML or unsafe links inside extension syntax', () => {
    const html = renderMarkdown('==<script>alert(1)</script>==\n\n==[链接](javascript:alert(1))==')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="javascript:')
  })

  it('highlights fenced code without interpreting its Markdown or HTML', () => {
    const source = '```sh\necho "<dev> **literal**"\necho "end"\n```'
    const options = { highlightCode: getCodeHighlightSegments }
    for (const html of [renderMarkdown(source, options), renderMarkdownWithLineData(source, 10, undefined, options)]) {
      expect(html).toContain('<span class="hljs-built_in">echo</span>')
      expect(html).toContain('&lt;dev&gt; **literal**')
      expect(html).not.toContain('<dev>')
      expect(html).not.toContain('<strong>')
    }
    const anchored = renderMarkdownWithLineData(source, 10, undefined, options)
    expect(anchored).toContain('data-line="12"')
    expect(anchored).toContain('data-line="13"')
  })

  it('keeps lightweight renderer consumers free of optional code highlighting', () => {
    expect(renderMarkdown('```js\nconst value = 1\n```')).not.toContain('hljs-')
  })

  it.each(['javascript', 'sh', 'unknown-language', undefined])('never changes code text while highlighting %s', language => {
    const source = 'const value = "<dev> & 中文🚨";\n/* first\nsecond */\n'
    expect(getCodeHighlightSegments(source, language).map(segment => segment.text).join('')).toBe(source)
    expect(getCodeHighlightSegments('', language).map(segment => segment.text).join('')).toBe('')
  })

  it('closes multiline syntax tokens inside each individual source-line anchor', () => {
    const html = renderMarkdownWithLineData('```js\n/* first\nsecond */\n```', 0, undefined, { highlightCode: getCodeHighlightSegments })
    expect(html).toContain('<span class="looma-preview-code-line" data-line="2"><span class="hljs-comment">/* first</span></span>')
    expect(html).toContain('<span class="looma-preview-code-line" data-line="3"><span class="hljs-comment">second */</span></span>')
  })
})
