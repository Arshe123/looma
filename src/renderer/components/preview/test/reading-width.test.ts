import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import postcss from 'postcss'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const preview = (name: string) => read(`src/renderer/components/preview/${name}.vue`)
const cssPath = 'src/renderer/styles/reading-area.css'
const declarations = (selector: string) => {
  const result: Record<string, string> = {}
  postcss.parse(existsSync(cssPath) ? read(cssPath) : '').walkRules(selector, rule => {
    rule.walkDecls(decl => { result[decl.prop] = decl.value })
  })
  return result
}

describe('preview reading width', () => {
  it('contains wide media inside the reading area without clipping the outer pane', () => {
    expect(declarations('.looma-reading-area.chunked-markdown table')).toMatchObject({
      display: 'block', width: '100%', 'min-width': '0', 'max-width': '100%', 'overflow-x': 'auto',
    })
    expect(declarations('.looma-reading-area .tableWrapper')).toMatchObject({
      'max-width': '100%', 'overflow-x': 'auto',
    })
    expect(declarations('.looma-reading-area img')).toMatchObject({
      'max-width': '100%', height: 'auto',
    })
    for (const name of ['TiptapPreview', 'ChunkedMarkdownPreview']) {
      expect(preview(name)).toContain('h-full w-full min-w-0')
      expect(preview(name)).toContain('overflow-y-auto')
    }
  })
  it('keeps active-line paint inside the text block rather than the wide outer whitespace', () => {
    const css = preview('TiptapPreview').split('<style>')[1]!.split('</style>')[0]!
    const active: Record<string, string> = {}
    postcss.parse(css).walkRules('.tiptap-preview-container .looma-active-line', rule => {
      rule.walkDecls(decl => { active[decl.prop] = decl.value })
    })
    expect(active.background).toBe('var(--editor-active-line-bg)')
    expect(active['box-shadow'] ?? 'none').toBe('none')
  })
  it('shares an opt-in border-box cap excluding each renderer’s existing padding', () => {
    for (const name of ['TiptapPreview', 'ChunkedMarkdownPreview']) {
      expect(preview(name)).toContain("import '@/renderer/styles/reading-area.css'")
      expect(preview(name)).toContain('looma-reading-area')
    }
    expect(declarations('.markdown-body.looma-reading-area')).toMatchObject({
      'box-sizing': 'border-box', width: '100%', 'min-width': '0',
      'max-width': 'calc(800px + var(--reading-padding-left) + var(--reading-padding-right))',
      'margin-inline': 'auto', '--reading-padding-left': '2rem', '--reading-padding-right': '2rem',
    })
    expect(declarations('.tiptap-preview-container .looma-reading-area')).toMatchObject({
      '--reading-padding-left': '3rem',
    })
    expect(preview('TiptapPreview')).not.toContain('max-w-none')
    expect(preview('ChunkedMarkdownPreview')).not.toContain('max-w-none')
    expect(read('src/renderer/components/editor/Editor.vue')).not.toContain('looma-reading-area')
    const help = read('src/renderer/components/help/HelpPage.vue')
    expect(help).toContain("import '@/renderer/styles/reading-area.css'")
    expect(help).toContain('help-markdown markdown-body looma-reading-area')
    expect(help).not.toContain('max-w-3xl')
    expect(declarations('.markdown-body.looma-reading-area.help-markdown')).toMatchObject({
      '--reading-padding-left': '2.5rem', '--reading-padding-right': '2.5rem',
    })
    expect(preview('NoteLinkPreview')).not.toContain('looma-reading-area')
  })
})
