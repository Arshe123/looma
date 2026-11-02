import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRenderer, h, nextTick, type Component } from 'vue'
import * as Vue from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transformSync } from 'esbuild'

const componentPath = '../../shared/CodeBlockCopy.vue'
type Element = { type: string; props: Record<string, any>; children: Element[]; text: string; parent?: Element }
function mount(component: Component, props: Record<string, unknown>) {
  const element = (type: string): Element => ({ type, props: {}, children: [], text: '' })
  const renderer = createRenderer<Element, Element>({
    createElement: element, createText: text => ({ ...element('#text'), text }), createComment: element,
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    parentNode: node => node.parent ?? null, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp: (node, key, _previous, value) => { node.props[key] = value },
    insert: (node, parent, anchor) => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
    },
    remove: node => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
  })
  const root = element('root')
  const app = renderer.createApp({ render: () => h(component, props) })
  app.mount(root)
  return { root, unmount: () => app.unmount() }
}
const text = (node: Element): string => node.text + node.children.map(text).join('')
const event = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() })
async function component() {
  expect(existsSync(new URL(componentPath, import.meta.url))).toBe(true)
  const descriptor = parse(readFileSync(new URL(componentPath, import.meta.url), 'utf8')).descriptor
  const code = transformSync(compileScript(descriptor, { id: 'code-copy-test', inlineTemplate: true }).content, { loader: 'ts', format: 'cjs' }).code
  const module = { exports: {} as { default: Component } }
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (id === 'vue') return Vue
    throw new Error(`Unexpected dependency: ${id}`)
  }, module, module.exports)
  return module.exports.default
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('shared engine-independent code presentation', () => {
  it('preserves editor focus and does not schedule feedback after a pending copy is unmounted', async () => {
    vi.useFakeTimers()
    let complete!: () => void
    vi.stubGlobal('navigator', { clipboard: { writeText: () => new Promise<void>(resolve => { complete = resolve }) } })
    const mounted = mount(await component(), { getText: () => 'body' })
    const button = mounted.root.children[0]
    const down = event()
    expect(button.props.onMousedown).toBeTypeOf('function')
    button.props.onMousedown(down)
    expect(down.preventDefault).toHaveBeenCalledOnce()
    const pending = button.props.onClick(event())
    mounted.unmount()
    complete()
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows language/copy affordance, copies current literal content on demand and resets status', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    let source = 'old'
    const getText = vi.fn(() => source)
    const mounted = mount(await component(), { language: ' js ', getText })
    const button = mounted.root.children[0]
    expect(button.props['aria-label']).toBe('复制 js 代码')
    expect(text(button)).toBe('js点击复制')
    expect(getText).not.toHaveBeenCalled()
    source = '<script> & **literal**\n'
    await button.props.onClick(event())
    await nextTick()
    expect(writeText).toHaveBeenCalledWith(source)
    expect(text(button)).toBe('已复制')
    await vi.advanceTimersByTimeAsync(1400)
    expect(text(button)).toBe('js点击复制')
    mounted.unmount()
  })
})
