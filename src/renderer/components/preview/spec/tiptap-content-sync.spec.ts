import { describe, expect, it, vi } from 'vitest'
import { replaceExternalMarkdownContent } from '../tiptap-content-sync'

describe('replaceExternalMarkdownContent', () => {
  it('replaces external content without adding the transaction to undo history', () => {
    const parsedContent = '<h1>Loaded</h1>'
    const doc = { type: 'doc' }
    const tr = {
      replaceWith: vi.fn(() => tr),
      setMeta: vi.fn(() => tr),
    }
    const dispatch = vi.fn()
    const parse = vi.fn(() => parsedContent)
    const createDoc = vi.fn(() => doc)

    replaceExternalMarkdownContent(
      {
        storage: { markdown: { parser: { parse } } },
        schema: { name: 'schema' },
        options: { parseOptions: { preserveWhitespace: 'full' }, enableContentCheck: true },
        state: { doc: { content: { size: 12 } }, tr },
        view: { dispatch },
      } as any,
      '# Loaded',
      createDoc as any,
    )

    expect(parse).toHaveBeenCalledWith('# Loaded')
    expect(createDoc).toHaveBeenCalledWith(
      parsedContent,
      { name: 'schema' },
      { preserveWhitespace: 'full' },
      { errorOnInvalidContent: true },
    )
    expect(tr.replaceWith).toHaveBeenCalledWith(0, 12, doc)
    expect(tr.setMeta).toHaveBeenCalledWith('preventUpdate', true)
    expect(tr.setMeta).toHaveBeenCalledWith('addToHistory', false)
    expect(dispatch).toHaveBeenCalledWith(tr)
  })
})
