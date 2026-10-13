import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const preview = () => read('../../../renderer/components/preview/TiptapPreview.vue')

describe('inline Markdown editor integration', () => {
  it('does not open a stale hover popup after the link changes to source', () => {
    const hover = read('../../../renderer/components/preview/NoteLinkPreview.vue')
    expect(hover.includes('if (!anchorEl.isConnected) return')).toBe(true)
    expect(hover.includes("document.addEventListener('selectionchange', onEditorSelectionChange)")).toBe(true)
    expect(hover.includes("document.removeEventListener('selectionchange', onEditorSelectionChange)")).toBe(true)
  })

  it('copies the original complete note reference even while it is expanded', () => {
    const context = read('../../../renderer/components/preview/ContextMenu.vue')
    expect(context.includes('getInlineMarkdownLinkAtPosition')).toBe(true)
    expect(context.includes('sourceLink.source')).toBe(true)
  })

  it('uses the source-backed inline extension instead of a detached source editor', () => {
    expect(preview()).toContain('InlineMarkdown,')
    expect(preview()).not.toContain('NoteRefSourceEditor')
    expect(preview()).not.toContain('handleMarkdownNoteRefEnter')
  })

  it('keeps block input rules but disables competing mark input/paste transformations', () => {
    expect(preview()).toContain('enableInputRules:')
    expect(preview()).toContain('enablePasteRules: false')
    expect(preview()).toContain('autolink: false')
    expect(preview()).toContain('linkOnPaste: false')
  })

  it('routes all five configured format shortcuts and menu entries to source transactions', () => {
    const menu = read('../../../renderer/components/preview/InlineMenu.vue')
    const actions = read('../tiptap-menu-actions.ts')
    expect(menu).toContain('toggleInlineMarkdownFormat(editor, formatAction)')
    for (const format of ['bold', 'italic', 'strike', 'inlineCode', 'highlight']) {
      expect(actions).toContain(`toggleInlineMarkdownFormat(editor, '${format}')`)
    }
  })
})
