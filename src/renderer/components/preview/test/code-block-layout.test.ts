import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('rich-text code block layout', () => {
  it('never shows the inline menu while the selection is in a code block', () => {
    const inlineMenu = readSource('src/renderer/components/preview/InlineMenu.vue')

    expect(inlineMenu).toContain('const isInCodeBlock = (editor: Editor) =>')
    expect(inlineMenu).toContain("return parent.type.name === 'codeBlock'")
    expect(inlineMenu).toContain('if (isInCodeBlock(editor))')
    expect(inlineMenu).not.toContain('isInNonEmptyCodeBlock')
    expect(inlineMenu).not.toContain("parent.type.name === 'codeBlock' && parent.textContent.length > 0")
  })

  it('uses one compact left gutter for code content and line numbers', () => {
    const codeBlock = readSource('src/renderer/components/preview/CodeBlockView.vue')
    const preview = readSource('src/renderer/components/preview/TiptapPreview.vue')

    expect(codeBlock).toContain('padding: 0.85rem 5.75rem 0.85rem 0;')
    expect(preview).toContain('padding-left: 2.25rem;')
    expect(preview).toContain('left: 0.25rem;')
    expect(preview).not.toContain('.code-block-content {\n  position: relative;\n  padding-left: 3rem;')
  })
})
