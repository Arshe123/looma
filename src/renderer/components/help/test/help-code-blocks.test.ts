import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import HelpPage from '../HelpPage.vue'
import { renderMarkdown } from '@/shared/utils/markdown-renderer'

describe('help code blocks', () => {
  it('renders examples without an unhandled copy button or language header', async () => {
    const html = await renderToString(createSSRApp(HelpPage))

    expect(html).toContain('<pre class="code-block-body"><code class="code-block-content language-markdown">')
    expect(html).toContain('# 我的读书笔记')
    expect(html).not.toContain('code-block-floating-copy')
    expect(html).not.toContain('code-block-copy-language')
    expect(html).not.toContain('点击复制')
  })

  it('preserves copy buttons for existing default renderer consumers', () => {
    const html = renderMarkdown('```javascript\nconst value = 1\n```')

    expect(html).toContain('code-block-floating-copy')
    expect(html).toContain('点击复制')
    expect(html).toContain('const value = 1')
  })
})
