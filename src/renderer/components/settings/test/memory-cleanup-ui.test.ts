import { afterEach, expect, it, vi } from 'vitest'
import { createRenderer, h, nextTick, type Component } from 'vue'
import * as Vue from 'vue'
import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transformSync } from 'esbuild'
import * as controller from '../memoryCleanup'

const descriptor = parse(readFileSync('src/renderer/components/settings/MemoryCleanup.vue', 'utf8')).descriptor
const compiled = transformSync(compileScript(descriptor, { id: 'cleanup-ui-test', inlineTemplate: true }).content, { loader: 'ts', format: 'cjs' }).code
const componentModule = { exports: {} as { default: Component } }
new Function('require', 'module', 'exports', compiled)((id: string) => {
  if (id === 'vue') return Vue
  if (id === './memoryCleanup') return controller
  if (id === './SettingsHelp.vue') return { default: { render: () => h('span') } }
  throw new Error(`Unexpected component import: ${id}`)
}, componentModule, componentModule.exports)
interface Host { tag: string; text: string; props: Record<string, any>; children: Host[]; parent: Host | null }
const node = (tag: string, text = ''): Host => ({ tag, text, props: {}, children: [], parent: null })
const renderer = createRenderer<Host, Host>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (target, text) => { target.text = text }, setElementText: (target, text) => { target.text = text; target.children = [] },
  patchProp: (target, key, _old, value) => { target.props[key] = value },
  insert(target, parent, anchor) {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1)
    target.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, target)
  },
  remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1) },
  parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
})
const text = (target: Host): string => target.tag === '#comment' ? '' : target.text + target.children.map(text).join('')
const all = (target: Host): Host[] => [target, ...target.children.flatMap(all)]
afterEach(() => { vi.unstubAllGlobals() })
it('renders exact preview and excluded scope, requires explicit confirmation and never reports failed cleanup as done', async () => {
  const api = { previewCleanup: vi.fn(async selection => ({ success: true, data: { selection, token: 'token', counts: { history: 3, snapshots: 2, user: 0, receipts: 1 }, records: ['<script>literal</script>'], skipped: ['foreign.txt'] } })), cleanup: vi.fn().mockResolvedValue({ success: false, error: '清理未完成' }) }
  vi.stubGlobal('window', { electronAPI: { agentMemory: api } })
  const root = node('root'); const app = renderer.createApp(componentModule.exports.default)
  app.mount(root)
  const button = (label: string) => all(root).find(item => item.tag === 'button' && text(item).trim() === label)!
  try {
    expect(button('确认清理')).toBeUndefined()
    await button('预览清理范围').props.onClick(); await nextTick()
    expect(text(root)).toContain('历史版本 3')
    expect(text(root)).toContain('待处理回执 1')
    expect(text(root)).toContain('旧聊天')
    expect(text(root)).toContain('foreign.txt')
    expect(all(root).some(item => item.tag === 'script')).toBe(false)
    expect(button('确认清理').props.disabled).toBe(true)
    await all(root).find(item => item.props['aria-label'] === '确认清理范围')!.props.onChange({ target: { checked: true } }); await nextTick()
    expect(button('确认清理').props.disabled).toBe(false)
    await button('确认清理').props.onClick(); await nextTick()
    expect(api.cleanup).toHaveBeenCalledOnce()
    expect(text(root)).toContain('清理未完成')
    expect(button('确认清理')).toBeUndefined()
  } finally { app.unmount() }
})
