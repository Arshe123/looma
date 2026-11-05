import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import postcss from 'postcss'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const ai = read('../../components/ai/AiMarkdown.vue')
const shared = read('../rich-text-presentation.css')
const rules = postcss.parse(shared)

function sharedDeclarations(selector: string) {
  const declarations: Record<string, string> = {}
  rules.walkRules(rule => {
    if (!rule.selectors.includes(`:is(.tiptap.markdown-body, .ai-markdown) ${selector}`)) return
    rule.walkDecls(decl => { declarations[decl.prop] = decl.value })
  })
  return declarations
}

describe('AI Markdown shared basic presentation', () => {
  it('shares ordinary rich-text rules without opting AI into editor layout or controls', () => {
    expect(ai).toContain("import '@/renderer/styles/rich-text-presentation.css'")
    expect(ai).toContain('class="ai-markdown"')
    expect(ai).not.toContain('class="markdown-body')
    expect(sharedDeclarations('p')).toMatchObject({ 'margin-top': '0', 'margin-bottom': '0.6em' })
    expect(sharedDeclarations(':is(h1, h2, h3, h4, h5, h6)')).toMatchObject({
      'font-weight': '600', 'line-height': '1.25',
    })
    expect(sharedDeclarations('h1')).toMatchObject({ 'font-size': 'var(--markdown-h1-size, 2em)' })
    expect(sharedDeclarations('ul')).toMatchObject({ 'list-style-type': 'disc', 'padding-left': '1.5rem' })
    expect(sharedDeclarations('ol ol')).toMatchObject({ 'list-style-type': 'lower-alpha' })
    expect(sharedDeclarations('blockquote')).toMatchObject({ color: 'var(--text-muted)', 'border-left': '0.25em solid var(--border-soft)' })
    expect(sharedDeclarations(':not(pre) > code')).toMatchObject({ 'background-color': 'var(--panel-soft)' })
    expect(sharedDeclarations('mark')).toMatchObject({ color: 'var(--text-main)' })
    expect(sharedDeclarations('a')).toMatchObject({ color: 'var(--accent)' })
    expect(sharedDeclarations('a:any-link')).toMatchObject({
      'text-decoration': 'none', 'border-bottom': '1px solid currentColor',
    })
    expect(sharedDeclarations('a.looma-note-ref')).toMatchObject({ 'border-bottom-style': 'dotted' })
  })

  it('reuses table cells and the full themed code palette while retaining AI overflow and copy behavior', () => {
    expect(ai).toContain("import '../shared/code-block-presentation.css'")
    expect(ai).not.toMatch(/\.ai-markdown \.code-block-content \.hljs-/)
    expect(ai).toContain("navigator.clipboard.writeText(code.textContent || '')")
    expect(ai).toContain('点击复制')
    expect(ai).toContain('已复制')
    const code = read('../../components/shared/code-block-presentation.css')
    const codeRules = postcss.parse(code)
    const selectorGroups: string[][] = []
    codeRules.walkRules(rule => { selectorGroups.push(rule.selectors) })
    for (const suffix of ['.code-block-shell', '.code-block-shell pre.code-block-body', '.code-block-content']) {
      expect(selectorGroups.some(group => group.includes(`.markdown-body ${suffix}`) && group.includes(`.ai-markdown ${suffix}`))).toBe(true)
    }
    for (const token of ['keyword', 'string', 'title', 'number', 'comment', 'regexp']) {
      expect(selectorGroups.some(group => group.includes(`.code-block-syntax .hljs-${token}`) && group.includes(`.ai-markdown .code-block-content .hljs-${token}`))).toBe(true)
    }
    const cellRules: string[][] = []
    rules.walkRules(rule => { cellRules.push(rule.selectors) })
    expect(cellRules.some(group => group.includes('.markdown-body.markdown-body table td') && group.includes('.ai-markdown table td'))).toBe(true)
    expect(ai).toMatch(/\.ai-markdown table\s*\{[^}]*display: block;[^}]*width: 100%;[^}]*max-width: 100%;[^}]*overflow-x: auto;/s)
    expect(ai).toContain('.ai-markdown li.task-list-item')
  })
})
