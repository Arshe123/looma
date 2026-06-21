import { describe, expect, it, vi } from 'vitest'
import { replaceExternalMarkdownContent } from './tiptap-content-sync'

describe('replaceExternalMarkdownContent', () => {
  it('sets external content explicitly as markdown without emitting an editor update', () => {
    const setContent = vi.fn(() => true)
    const editor = {
      commands: { setContent },
      options: { enableContentCheck: true },
    }

    expect(replaceExternalMarkdownContent(editor, '# heading')).toBe(true)
    expect(setContent).toHaveBeenCalledWith('# heading', {
      contentType: 'markdown',
      emitUpdate: false,
      errorOnInvalidContent: true,
    })
  })
})
