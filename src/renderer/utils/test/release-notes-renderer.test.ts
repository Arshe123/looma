import { describe, expect, it } from 'vitest'
import { renderReleaseNotes } from '../release-notes-renderer'

describe('release notes renderer', () => {
  it('renders GitHub Markdown release notes', () => {
    const html = renderReleaseNotes('## 新功能\n\n- 支持 **快速更新**')

    expect(html).toContain('<h2>新功能</h2>')
    expect(html).toContain('<li>支持 <strong>快速更新</strong></li>')
  })

  it('escapes updater HTML when a DOM sanitizer is unavailable', () => {
    const html = renderReleaseNotes('<p>修复问题</p><script>alert(1)</script>')

    expect(html).toContain('&lt;p&gt;修复问题&lt;/p&gt;')
    expect(html).not.toContain('<script>')
  })
})
