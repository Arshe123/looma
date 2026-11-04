import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxTreeAvailable } from '@codemirror/language'
import { buildContinuousCodeDecorations, updateContinuousCodeHover } from '../continuousMarkdownCode'
import CodeBlockCopy from '../../shared/CodeBlockCopy.vue'
import { parsedMarkdownState } from './parsed-markdown-state'

const { render } = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('vue', async original => ({ ...await original<typeof import('vue')>(), render }))

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
function element() {
  return { className: '', contentEditable: '', textContent: '', value: '', disabled: false,
    children: [] as any[], events: {} as Record<string, (event?: unknown) => void>,
    querySelector: () => null,
    setAttribute: vi.fn(), appendChild(child: any) { this.children.push(child) },
    append(...children: any[]) { this.children.push(...children) },
    addEventListener(name: string, listener: (event?: unknown) => void) { this.events[name] = listener },
  }
}

describe('shared code presentation adapters', () => {
  it('publishes the completed tree after the initial parse budget expires', () => {
    let clock = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock += 100)
    let state: EditorState
    try {
      state = EditorState.create({ doc: 'before\n\n```js\na\n\nb\n```', extensions: [markdown()] })
    } finally { now.mockRestore() }
    const numbers = (state: EditorState) => {
      const lines: number[] = []
      buildContinuousCodeDecorations(state, [{ from: 0, to: state.doc.length }]).between(0, state.doc.length, (from, to, decoration) => {
        if (from === to && decoration.spec.widget) lines.push(state.doc.lineAt(from).number)
      })
      return lines
    }
    expect(syntaxTreeAvailable(state, state.doc.length)).toBe(false)
    expect(numbers(state)).toEqual([])
    expect(numbers(parsedMarkdownState(state))).toEqual([4, 5, 6])
  })
  it('adds display-only absolute source numbers on code content, not fences, within visible lines', () => {
    const source = 'before\n\n```js\na\n\nb\n```'
    const state = parsedMarkdownState(EditorState.create({ doc: source, extensions: [markdown()] }))
    const collect = (from: number, to: number) => {
      const numbers: number[] = []
      buildContinuousCodeDecorations(state, [{ from, to }]).between(0, state.doc.length, (at, end, decoration) => {
        if (decoration.spec.widget && at === end) {
          const dom = decoration.spec.widget.toDOM({ dom: { ownerDocument: { createElement: element } } } as any)
          expect(dom.className).toContain('looma-line-number')
          expect(dom.contentEditable).toBe('false')
          expect(dom.setAttribute).toHaveBeenCalledWith('data-line', String(state.doc.lineAt(at).number))
          numbers.push(Number(dom.textContent))
        }
      })
      return numbers
    }
    expect(collect(0, state.doc.length)).toEqual([4, 5, 6])
    expect(collect(state.doc.line(5).from, state.doc.line(6).to)).toEqual([5, 6])
    expect(state.doc.toString()).toBe(source)
  })
  it('keeps the language selector hidden until badge right-click or keyboard disclosure, including read-only copy', () => {
    const state = parsedMarkdownState(EditorState.create({ doc: '```js\na\n```', extensions: [markdown(), EditorState.readOnly.of(true)] }))
    let widget: any
    buildContinuousCodeDecorations(state, [{ from: 0, to: state.doc.length }]).between(0, state.doc.length, (from, to, d) => {
      if (d.spec.widget && from < to) widget = d.spec.widget
    })
    const root = widget.toDOM({ state, dom: { ownerDocument: { createElement: element } }, posAtDOM: () => 0 })
    const label = root.children[0]
    expect(label.hidden).toBe(true)
    expect(label.children[0].disabled).toBe(true)
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    root.events.contextmenu(event)
    expect(label.hidden).toBe(false)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    root.events.keydown({ ...event, key: 'Escape' })
    expect(label.hidden).toBe(true)
    root.events.keydown({ ...event, key: 'F10', shiftKey: true })
    expect(label.hidden).toBe(false)
    widget.destroy(root)
  })

  it('reveals only the toolbar belonging to any hovered content line, and clears on exit', () => {
    const line = (id: string) => ({ getAttribute: () => id })
    const toolbars = ['0', '100'].map(id => ({ closest: () => line(id), classList: { toggle: vi.fn() } }))
    const view = { dom: { contains: () => true, querySelectorAll: () => toolbars } } as any
    for (const id of ['0', '100']) {
      updateContinuousCodeHover(view, { closest: () => line(id) } as any)
      toolbars.forEach((toolbar, i) => expect(toolbar.classList.toggle).toHaveBeenLastCalledWith('is-block-hovered', String(i * 100) === id))
    }
    updateContinuousCodeHover(view, null)
    toolbars.forEach(toolbar => expect(toolbar.classList.toggle).toHaveBeenLastCalledWith('is-block-hovered', false))
  })

  it('matches native content padding and shares hover/focus badge visibility without always-visible overrides', () => {
    const css = source('../../shared/code-block-presentation.css')
    expect(css).toMatch(/padding-inline: 2\.25rem 1rem/)
    expect(css).toMatch(/\.looma-continuous-code-line-number\s*\{[^}]*left: 0\.25rem[^}]*min-width: 1\.5rem/s)
    expect(css).toContain('.looma-continuous-code-toolbar.is-block-hovered .code-block-floating-copy')
    expect(css).toContain('.looma-continuous-code-toolbar:focus-within .code-block-floating-copy')
    expect(css).not.toMatch(/\.looma-continuous-code-toolbar \.code-block-floating-copy\s*\{[^}]*opacity: 1/s)
  })

  it('does not collapse a pathological info line that still contains editable source', () => {
    const state = parsedMarkdownState(EditorState.create({ doc: '```' + 'x'.repeat(20_000) + '\nbody\n```', extensions: [markdown()] }))
    const decorations = buildContinuousCodeDecorations(state, [{ from: 0, to: 200 }])
    const classes: string[] = []
    decorations.between(0, 200, (_from, _to, decoration) => { if (decoration.spec.class) classes.push(decoration.spec.class) })
    expect(classes.join(' ')).not.toContain('looma-code-fence-start')
  })

  it('adds a contiguous shell only on visible native source lines with real start/end boundaries', () => {
    const state = parsedMarkdownState(EditorState.create({ doc: 'before\n\n```js\na\nb\n```\n\nafter', extensions: [markdown()] }))
    const lines = (ranges: { from: number; to: number }[]) => {
      const result: [number, string][] = []
      buildContinuousCodeDecorations(state, ranges).between(0, state.doc.length, (from, _to, decoration) => {
        if (decoration.spec.class?.includes('looma-code-line')) result.push([state.doc.lineAt(from).number, decoration.spec.class])
      })
      return result
    }
    const all = lines([{ from: 0, to: state.doc.length }])
    expect(all.map(([line]) => line)).toEqual([3, 4, 5, 6])
    expect(all[0][1]).toContain('looma-code-block-start')
    expect(all[3][1]).toContain('looma-code-block-end')
    const middle = lines([{ from: state.doc.line(4).from, to: state.doc.line(5).to }])
    expect(middle.map(([line]) => line)).toEqual([4, 5])
    expect(middle.every(([, classes]) => !classes.includes('looma-code-block-start') && !classes.includes('looma-code-block-end'))).toBe(true)
  })

  it('mounts the shared copy component outside editor updates, resolves live positions and unmounts on widget destroy', async () => {
    render.mockClear()
    const original = '```js\nconst a = 1\n```'
    const state = parsedMarkdownState(EditorState.create({ doc: original, extensions: [markdown()] }))
    const decorations = buildContinuousCodeDecorations(state, [{ from: 0, to: state.doc.length }])
    let widget: any
    decorations.between(0, state.doc.length, (from, to, decoration) => { if (decoration.spec.widget && from < to) widget = decoration.spec.widget })
    const read = vi.spyOn(state, 'sliceDoc')
    const view = { state, dom: { ownerDocument: { createElement: element } }, posAtDOM: vi.fn(() => 0), dispatch: vi.fn() }
    const root = widget.toDOM(view)
    expect(read).not.toHaveBeenCalled()
    expect(render).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(render).toHaveBeenCalledOnce()
    const [vnode, host] = render.mock.calls[0]
    expect(vnode.type).toBe(CodeBlockCopy)
    expect(vnode.props.language).toBe('js')
    view.state = parsedMarkdownState(state.update({ changes: { from: 0, insert: 'before\n\n' } }).state)
    view.posAtDOM.mockReturnValue(8)
    expect(vnode.props.getText()).toBe('const a = 1\n')
    expect(view.posAtDOM).toHaveBeenCalledWith(root)
    const next = buildContinuousCodeDecorations(state, [{ from: 0, to: state.doc.length }])
    let equivalent: any
    next.between(0, state.doc.length, (from, to, decoration) => { if (decoration.spec.widget && from < to) equivalent = decoration.spec.widget })
    expect(equivalent.eq(widget)).toBe(true)
    // CodeMirror transfers equal widgets' DOM to the newer widget instance.
    equivalent.destroy(root)
    expect(render).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(render).toHaveBeenLastCalledWith(null, host)
  })

  it('uses the same component and stylesheet in both adapters with one syntax palette', () => {
    const ordinary = source('../../preview/CodeBlockView.vue')
    const continuous = source('../continuousMarkdownCode.ts')
    expect(ordinary).toContain("import CodeBlockCopy from '../shared/CodeBlockCopy.vue'")
    expect(ordinary).toContain('<CodeBlockCopy')
    for (const adapter of [ordinary, continuous]) expect(adapter).toContain("import '../shared/code-block-presentation.css'")
    expect(ordinary).not.toContain('navigator.clipboard')
    expect(continuous).not.toContain('navigator.clipboard')
    expect(continuous).not.toContain("color: '#c678dd'")
    const css = source('../../shared/code-block-presentation.css')
    expect(css).toContain('.code-block-syntax .hljs-keyword')
    expect(css).toContain('.looma-continuous-code-token.hljs-keyword')
    expect(css).toContain('[data-theme="dark"]')
    expect(css).toMatch(/\.looma-continuous-code-toolbar\s*\{[^}]*position: absolute/s)
    expect(css).toMatch(/\.cm-editor \.cm-line\.looma-code-fence-end\s*\{[^}]*height: 0\.85rem/s)
  })
})
