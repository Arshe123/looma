import { afterEach, expect, it, vi } from 'vitest'
import { createRenderer, h, nextTick, type Component } from 'vue'
import * as Vue from 'vue'
import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transformSync } from 'esbuild'
import * as controller from '../userProfileHistory'
import { createMemoryEditor } from '../memoryEditor'

// Vitest's Node transform uses SSR templates; compile the real client SFC here.
const descriptor = parse(readFileSync('src/renderer/components/settings/UserProfileHistory.vue', 'utf8')).descriptor
const compiled = transformSync(compileScript(descriptor, { id: 'history-ui-test', inlineTemplate: true }).content, { loader: 'ts', format: 'cjs' }).code
const componentModule = { exports: {} as { default: Component } }
new Function('require', 'module', 'exports', compiled)((id: string) => {
  if (id === 'vue') return Vue
  if (id === './userProfileHistory') return controller
  if (id === './SettingsHelp.vue') return { default: { render: () => h('span') } }
  throw new Error(`Unexpected component import: ${id}`)
}, componentModule, componentModule.exports)
const UserProfileHistory = componentModule.exports.default

// Exercise the real compiled SFC with Vue's host renderer, without a browser DOM.
interface HostNode { tag: string; text: string; props: Record<string, unknown>; children: HostNode[]; parent: HostNode | null }
const node = (tag: string, text = ''): HostNode => ({ tag, text, props: {}, children: [], parent: null })
const renderer = createRenderer<HostNode, HostNode>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (target, text) => { target.text = text },
  setElementText: (target, text) => { target.text = text; target.children = [] },
  patchProp: (target, key, _old, value) => { target.props[key] = value },
  insert(target, parent, anchor) {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1)
    target.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, target)
  },
  remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1) },
  parentNode: target => target.parent,
  nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
})
const text = (target: HostNode): string => target.tag === '#comment' ? '' : target.text + target.children.map(text).join('')
const all = (target: HostNode): HostNode[] => [target, ...target.children.flatMap(all)]
const click = async (target: HostNode) => {
  expect(target.props.disabled).not.toBe(true)
  await (target.props.onClick as () => unknown)()
  await nextTick()
}
afterEach(() => { vi.unstubAllGlobals() })

it('renders damaged pages honestly, disables invalid viewing, and browses/restores a healthy later page', async () => {
  const invalid = { id: 'broken', createdAt: 1, status: 'invalid', error: '历史版本缺失或已损坏，无法查看或恢复。' }
  const healthy = { id: 'healthy', createdAt: 0, status: 'valid', source: 'manual', revision: 'old', content: '<script>literal</script>' }
  const api = {
    read: vi.fn().mockResolvedValue({ success: true, data: { content: 'current', revision: 'current' } }), save: vi.fn(),
    listUserHistory: vi.fn().mockResolvedValueOnce({ success: true, data: { entries: [invalid], nextCursor: 'broken' } })
      .mockResolvedValue({ success: true, data: { entries: [healthy] } }),
    readUserHistory: vi.fn().mockResolvedValue({ success: true, data: healthy }),
    restoreUserHistory: vi.fn().mockResolvedValue({ success: true, data: healthy }),
  }
  vi.stubGlobal('window', { electronAPI: { agentMemory: api } })
  const editor = createMemoryEditor('user', api)
  await editor.load()
  const root = node('root')
  const app = renderer.createApp({ render: () => h(UserProfileHistory, { editor }) })
  app.mount(root)
  const button = (label: string) => all(root).find(item => item.tag === 'button' && text(item).trim() === label)!
  try {
    await click(button('历史版本'))
    expect(text(root)).toContain('无法查看或恢复。')
    expect(text(root)).toContain('文件已保留')
    expect(text(root)).toContain('可加载更早版本继续查找')
    expect(text(root)).not.toContain('暂无历史版本；')
    const damagedButton = all(root).find(item => item.tag === 'button' && text(item).includes('无法查看或恢复'))!
    expect(damagedButton.props.disabled).toBe(true)
    expect(button('恢复上一版').props.disabled).toBe(true)
    expect(all(root).some(item => item.tag === 'pre')).toBe(false)
    await click(button('加载更早版本'))
    expect(api.listUserHistory).toHaveBeenLastCalledWith('broken')
    await click(button('恢复上一版'))
    expect(api.readUserHistory).toHaveBeenCalledWith('healthy')
    expect(text(root)).toContain('<script>literal</script>')
    expect(all(root).some(item => item.tag === 'script')).toBe(false)
    await click(button('确认恢复'))
    expect(api.restoreUserHistory).toHaveBeenCalledWith('healthy', 'current')
    expect(editor.content).toBe(healthy.content)
  } finally { app.unmount() }
})
