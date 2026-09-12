import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { transformSync } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NoteTemplateManager from '../NoteTemplateManager.vue'

const source = readFileSync(resolve(process.cwd(), 'src/renderer/components/templates/NoteTemplateManager.vue'), 'utf8')
const renderPreview = async (contentTemplate: string) => {
  vi.stubGlobal('window', { electronAPI: { noteTemplates: {} } })
  const html = await renderToString(createSSRApp({ render: () => h(NoteTemplateManager, {
    store: { schemaVersion: 1, revision: 1, templates: [{
      id: 'preview', name: '预览测试', fileNameTemplate: '{{ title }}', contentTemplate,
      variables: [
        { id: 'title', name: 'title', type: 'string', value: '标题', afterUseExpression: '' },
        { id: 'name', name: 'name', type: 'string', value: 'Looma', afterUseExpression: '' },
      ], createdAt: 0, updatedAt: 0,
    }] },
  }) }))
  return html.slice(html.indexOf('<summary class="cursor-pointer px-4 py-3'), html.indexOf('</details>'))
}

afterEach(() => { vi.unstubAllGlobals() })

describe('template Markdown preview', () => {
  it('does not let global note hover handlers resolve links against the active note', () => {
    expect(source).toContain('@mouseover.stop')
    expect(source).toContain('@mouseout.stop')
  })
  it('uses scoped theme tokens and contains wide content instead of a monospace source block', () => {
    expect(source).toContain('<style scoped>')
    expect(source).toContain('font-family: var(--font-body)')
    expect(source).toContain('font-family: var(--font-code)')
    expect(source).toContain('.template-markdown-preview :deep(table)')
    expect(source).toContain('.template-markdown-preview :deep(mark)')
    expect(source).toContain('background: var(--panel-soft)')
    expect(source).toContain('max-h-48 min-w-0 overflow-auto')
  })
  it('preserves shared Markdown structures and escapes executable input in actual preview HTML', async () => {
    const html = await renderPreview('*斜体* ~~删除~~ `==literal==` ==高亮==\n\n> 引用\n\n- 无序\n\n1. 有序\n\n- [x] 完成\n\n| 列 |\n| --- |\n| 值 |\n\n```text\n**literal**\n<script>alert(1)</script>\n```\n\n[外链](https://example.com) [内部](note.md)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[危险](javascript:alert(1))')
    for (const tag of ['<em>', '<s>', '<mark>', '<blockquote>', '<ul>', '<ol>', '<table>', 'disabled=""', 'code-block-content', 'looma-note-ref', 'looma-external-link']) expect(html).toContain(tag)
    expect(html).toContain('<code>==literal==</code>')
    expect(html).toContain('**literal**\n&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img ')
    expect(html).not.toContain('href="javascript:')
  })
  it('intercepts links and copies code with Chinese feedback without navigation or submission', async () => {
    const handlerSource = source.match(/const handlePreviewClick = async[\s\S]*?(?=\nconst filenameError)/)?.[0]
    expect(handlerSource).toBeTruthy()
    const feedback = { value: '' }
    const handler = new Function('previewFeedback', `${transformSync(handlerSource!, { loader: 'ts' }).code}; return handlePreviewClick`)(feedback)
    class Target {
      constructor(private href: string | null, private code?: string) {}
      closest(selector: string) {
        if (selector === '.code-block-floating-copy' && this.code !== undefined) return { closest: () => ({ querySelector: () => ({ textContent: this.code }) }) }
        if (selector === 'a[href]' && this.href !== null) return { getAttribute: () => this.href }
        return null
      }
    }
    vi.stubGlobal('Element', Target)
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { electronAPI: { app: { openExternal } } })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const click = async (target: Target) => {
      const event = { target, preventDefault: vi.fn(), stopPropagation: vi.fn() }
      await handler(event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(event.stopPropagation).toHaveBeenCalledOnce()
    }
    await click(new Target('https://example.com'))
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
    await click(new Target('note.md#标题'))
    expect(feedback.value).toBe('创建笔记后可打开内部链接')
    await click(new Target('mailto:test@example.com'))
    expect(openExternal).toHaveBeenCalledOnce()
    await click(new Target(null, '<tag>\n**literal**\n'))
    expect(writeText).toHaveBeenCalledWith('<tag>\n**literal**\n')
    expect(feedback.value).toBe('代码已复制')
    writeText.mockRejectedValueOnce(new Error('denied'))
    await click(new Target(null, 'retry'))
    expect(feedback.value).toBe('复制失败，请重试')
    openExternal.mockRejectedValueOnce(new Error('denied'))
    await click(new Target('https://example.com'))
    expect(feedback.value).toBe('打开链接失败，请重试')
    expect(source).toContain('@click.capture="handlePreviewClick"')
    expect(source).toContain('@auxclick.capture="handlePreviewClick"')
    expect(source).toContain('role="status"')
  })
  it('prepares local image placeholders in an inert template before v-html insertion', () => {
    expect(source).toContain("document.createElement('template')")
    expect(source).toContain("fragment.content.querySelectorAll('img')")
    expect(source).toContain("image.removeAttribute('src')")
    expect(source).toContain('image.replaceWith(placeholder)')
    expect(source).toContain('相对路径图片将在创建笔记后显示')
    expect(source).toContain('return fragment.innerHTML')
    expect(source).not.toContain('new DOMParser')
  })
  it('shows Chinese plain-text errors and a separate empty state', async () => {
    expect(await renderPreview('{{ missing }}')).toContain('role="alert"')
    expect(await renderPreview('{{ missing }}')).not.toContain('template-markdown-preview')
    expect(await renderPreview('  ')).toContain('暂无内容')
    expect(await renderPreview('  ')).not.toContain('template-markdown-preview')
  })
  it('renders evaluated expressions as Markdown in the real manager', async () => {
    const html = await renderPreview('# {{ title }}\n\n**{{ name }}**')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<strong>Looma</strong>')
    expect(html).toContain('markdown-body template-markdown-preview')
    expect(source).toContain("from '@/shared/utils/markdown-renderer'")
  })
})
