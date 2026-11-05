import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRenderer, h, nextTick, type Component } from 'vue'
import * as Vue from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transformSync } from 'esbuild'
import * as workspace from '../../stores/workspace'
import * as externalDocuments from '../../stores/externalDocuments'
import * as tabUtils from '../../stores/workspace-tab-utils'
import * as tabClosing from '../../utils/document-tab-closing'
import * as treeUtils from '../../../shared/utils/file-tree-utils'

// Compile the client template, as the Node test transform otherwise uses SSR.
const descriptor = parse(readFileSync('src/renderer/components/EditorTabs.vue', 'utf8')).descriptor
const compiled = transformSync(compileScript(descriptor, { id: 'editor-tabs-test', inlineTemplate: true }).content, { loader: 'ts', format: 'cjs' }).code
const componentModule = { exports: {} as { default: Component } }
new Function('require', 'module', 'exports', compiled)((id: string) => {
  // Keep keyed reconciliation real; omit only browser-specific FLIP measurement.
  if (id === 'vue') return { ...Vue, TransitionGroup: { setup: (_: unknown, { slots }: { slots: { default: () => unknown } }) => () => h('div', slots.default()) } }
  if (id === '../stores/workspace') return workspace
  if (id === '../stores/externalDocuments') return externalDocuments
  if (id === '@/renderer/stores/workspace-tab-utils') return tabUtils
  if (id === '@/renderer/utils/document-tab-closing') return tabClosing
  if (id === '@/shared/utils/file-tree-utils') return treeUtils
  if (id === 'lucide-vue-next') return { X: { render: () => h('svg') }, FileSymlink: { render: () => h('svg') } }
  throw new Error(`Unexpected component import: ${id}`)
}, componentModule, componentModule.exports)

interface HostNode {
  tag: string; text: string; props: Record<string, unknown>; children: HostNode[]; parent: HostNode | null
  scrollLeft: number; clientWidth: number; offsetLeft: number; offsetWidth: number
  dataset: { documentTab?: string }
}
const node = (tag: string, text = ''): HostNode => ({
  tag, text, props: {}, children: [], parent: null,
  scrollLeft: 0, clientWidth: 0, offsetLeft: 0, offsetWidth: 0,
  get dataset() { return { documentTab: this.props['data-document-tab'] as string | undefined } },
})
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
const all = (target: HostNode): HostNode[] => [target, ...target.children.flatMap(all)]
const text = (target: HostNode): string => target.tag === '#comment' ? '' : target.text + target.children.map(text).join('')

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('updates the existing preview node in place, including its title and close handler', async () => {
  const store = workspace.useWorkspaceStore()
  vi.spyOn(store, 'saveWorkspaceMeta').mockResolvedValue()
  const close = vi.spyOn(store, 'closeTab').mockResolvedValue(true)
  store.openFileTab('left.md')
  store.openPreviewFileTab('a.md')
  store.openFileTab('right.md')
  const root = node('root')
  const app = renderer.createApp(componentModule.exports.default)
  app.mount(root)
  const tabs = () => all(root).filter(item => item.props['data-document-tab'])
  const original = tabs()
  try {
    store.openPreviewFileTab('b.md')
    await nextTick()
    expect(tabs()).toHaveLength(3)
    expect(tabs()[1]).toBe(original[1])
    expect(tabs()[0]).toBe(original[0])
    expect(tabs()[2]).toBe(original[2])
    expect(tabs()[1].props['data-document-tab']).toBe('file:b.md')
    expect(text(tabs()[1])).toBe('b')
    expect(tabs()[1].props.title).toContain('b.md（预览')
    const button = all(tabs()[1]).find(item => item.tag === 'button')!
    await (button.props.onClick as (event: Event) => Promise<void>)({ stopPropagation() {} } as Event)
    expect(close).toHaveBeenCalledWith('file:b.md')
  } finally { app.unmount() }
})

it('keeps retained and reopened tabs distinct while reusing only the current preview', async () => {
  const store = workspace.useWorkspaceStore()
  vi.spyOn(store, 'saveWorkspaceMeta').mockResolvedValue()
  store.openPreviewFileTab('a.md')
  const root = node('root')
  const app = renderer.createApp(componentModule.exports.default)
  app.mount(root)
  const tabs = () => all(root).filter(item => item.props['data-document-tab'])
  const original = tabs()[0]
  try {
    store.openPreviewFileTab('b.md')
    await nextTick()
    expect(tabs()[0]).toBe(original)
    const retain = tabs()[0].props.onDblclick as () => void
    retain()
    await nextTick()
    expect(store.previewTabId).toBe('')
    expect(tabs()[0]).toBe(original)
    store.openPreviewFileTab('a.md')
    await nextTick()
    const preview = tabs()[1]
    expect(preview).not.toBe(original)
    expect(tabs().map(tab => tab.props['data-document-tab'])).toEqual(['file:b.md', 'file:a.md'])
    store.openPreviewFileTab('c.md')
    store.openPreviewFileTab('d.md')
    await nextTick()
    expect(tabs()[0]).toBe(original)
    expect(tabs()[1]).toBe(preview)
    expect(tabs()[1].props['data-document-tab']).toBe('file:d.md')
    store.openPreviewFileTab('b.md')
    await nextTick()
    expect(store.previewTabId).toBe('file:d.md')
    expect(tabs()[0]).toBe(original)
    expect(tabs()[1]).toBe(preview)
  } finally { app.unmount() }
})

it('preserves the preview slot next to external tabs and keeps nodes stable on reorder', async () => {
  const store = workspace.useWorkspaceStore()
  vi.spyOn(store, 'saveWorkspaceMeta').mockResolvedValue()
  store.openPreviewFileTab('a.md')
  const root = node('root')
  const app = renderer.createApp(componentModule.exports.default)
  app.mount(root)
  const tabs = () => all(root).filter(item => item.props['data-document-tab'])
  try {
    externalDocuments.useExternalDocumentsStore().open({ id: 'external:note', filePath: '/outside/note.md', content: '', baseContent: '' })
    await nextTick()
    store.openFileTab('right.md')
    await nextTick()
    const original = tabs()
    expect(original.map(tab => tab.props['data-document-tab'])).toEqual(['file:a.md', 'external:note', 'file:right.md'])
    store.openPreviewFileTab('b.md')
    await nextTick()
    expect(tabs().map(tab => tab.props['data-document-tab'])).toEqual(['file:b.md', 'external:note', 'file:right.md'])
    for (const [index, tab] of tabs().entries()) expect(tab).toBe(original[index])
    store.setTabs([...store.tabs].reverse())
    await nextTick()
    expect(tabs().map(tab => tab.props['data-document-tab'])).toEqual(['file:right.md', 'external:note', 'file:b.md'])
    expect(tabs()[0]).toBe(original[2])
    expect(tabs()[1]).toBe(original[1])
    expect(tabs()[2]).toBe(original[0])
  } finally { app.unmount() }
})

it('reveals activated tabs by the minimum distance, even when clicking the current file again', async () => {
  const store = workspace.useWorkspaceStore()
  vi.spyOn(store, 'saveWorkspaceMeta').mockResolvedValue()
  for (const file of ['left.md', 'middle.md', 'right.md']) store.openFileTab(file)
  const root = node('root')
  const app = renderer.createApp(componentModule.exports.default)
  app.mount(root)
  const tabs = all(root).filter(item => item.props['data-document-tab'])
  const container = tabs[0].parent!
  container.clientWidth = 240
  tabs.forEach((tab, index) => { tab.offsetLeft = index * 124; tab.offsetWidth = 120 })
  try {
    store.openPreviewFileTab('right.md')
    await nextTick()
    expect(container.scrollLeft).toBe(128)
    store.openPreviewFileTab('middle.md')
    await nextTick()
    expect(container.scrollLeft).toBe(124)
    store.openPreviewFileTab('left.md')
    await nextTick()
    expect(container.scrollLeft).toBe(0)
    store.openPreviewFileTab('middle.md')
    await nextTick()
    expect(container.scrollLeft).toBe(4)
    container.scrollLeft = 100
    store.openPreviewFileTab('middle.md')
    await nextTick()
    expect(container.scrollLeft).toBe(100)
    container.scrollLeft = 250
    store.openPreviewFileTab('middle.md')
    await nextTick()
    expect(container.scrollLeft).toBe(124)
  } finally { app.unmount() }
})
