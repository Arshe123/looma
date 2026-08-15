import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownWithLineData } from '../markdown-renderer'

describe('markdown == highlight rendering', () => {
  it('renders double-equals text as a mark element', () => {
    expect(renderMarkdown('before ==highlighted== after')).toContain(
      'before <mark>highlighted</mark> after',
    )
  })

  it('renders highlights in the chunked preview path', () => {
    expect(renderMarkdownWithLineData('==highlighted==', 10)).toContain(
      '<mark>highlighted</mark>',
    )
  })

  it('leaves double equals inside inline code unchanged', () => {
    expect(renderMarkdown('`==not highlighted==`')).toContain(
      '<code>==not highlighted==</code>',
    )
  })
})