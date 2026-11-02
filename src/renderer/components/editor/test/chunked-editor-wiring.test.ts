import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const wrapper = readFileSync(new URL('../MarkdownEditor.vue', import.meta.url), 'utf8')

describe('large Markdown editing integration', () => {
  it('keeps one continuous full-source editing view instead of activating boxed source blocks', () => {
    const editor = readFileSync(new URL('../ChunkedMarkdownEditor.vue', import.meta.url), 'utf8')
    expect(editor).toContain('continuousMarkdown(')
    expect(editor).toContain('doc: doc().text')
    expect(editor).toContain('changesSince(')
    expect(editor).not.toContain('chunked-active-host')
    expect(editor).not.toContain('chunked-edit-active')
    expect(editor).not.toContain('v-html=')
    expect(editor).not.toContain('MAX_WINDOW_CHARS')
  })
  it('uses a bounded chunk editor rather than a readonly preview for large notes', () => {
    expect(wrapper).toContain('<ChunkedMarkdownEditor')
    expect(wrapper).toContain("import('./ChunkedMarkdownEditor.vue')")
    const branch = wrapper.slice(wrapper.indexOf('<ChunkedMarkdownEditor'), wrapper.indexOf('<TiptapPreview'))
    expect(branch).toContain('@update:content=')
    expect(branch).toContain('@save=')
    expect(branch).toContain('@edit-pending=')
    expect(branch).toContain('@request-edit=')
  })

  it('flushes the active large editor before saving or changing modes', () => {
    expect(wrapper).toContain('getEditablePreview')
    expect(wrapper).toContain('getEditablePreview()?.flushPendingMarkdownEmit?.()')
  })

  it('classifies external large files instead of forcing the full rich-text path', () => {
    const external = readFileSync(new URL('../../ExternalDocuments.vue', import.meta.url), 'utf8')
    expect(external.includes(':use-chunked-preview="false"')).toBe(false)
    expect(external.includes('largeFileFor(doc)')).toBe(true)
  })
})
