import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transformSync } from 'esbuild'
import { createPinia, setActivePinia } from 'pinia'
import { expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import * as workspace from '../../../stores/workspace'
import * as historyUtils from '../../../stores/workspace-ai-utils'

const compile = (file: string, imports: Record<string, unknown> = {}) => {
  const descriptor = parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).descriptor
  const { code } = transformSync(compileScript(descriptor, { id: file, inlineTemplate: true }).content, { loader: 'ts', format: 'cjs' })
  const component = { exports: {} as { default: Vue.Component } }
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (id === 'vue') return { ...Vue, vModelText: {}, vModelSelect: {} }
    if (id === '@/renderer/stores/workspace') return workspace
    if (id === '@/renderer/stores/workspace-ai-utils') return historyUtils
    if (id === 'lucide-vue-next') return new Proxy({}, { get: () => () => Vue.h('svg') })
    if (id in imports) return imports[id]
    throw new Error(`Unexpected component import: ${id}`)
  }, component, component.exports)
  return component.exports
}
const panel = compile('AiConversationHistoryPanel.vue')
const page = compile('AiConversationHistoryPage.vue', { './AiConversationHistoryPanel.vue': panel })

interface Node {
  tag: string
  text: string
  props: Record<string, unknown>
  children: Node[]
  parent: Node | null
}
const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [], parent: null })
const remove = (target: Node) => {
  if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1)
  target.parent = null
}
const renderer = Vue.createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: value => node('#text', value), createComment: () => node('#comment'),
  setText: (target, value) => { target.text = value },
  setElementText: (target, value) => { target.text = value; target.children = [] },
  patchProp: (target, key, _previous, value) => { target.props[key] = value },
  insert(target, parent, anchor) {
    remove(target)
    target.parent = parent
    parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, target)
  },
  remove,
  parentNode: target => target.parent,
  nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
})
const all = (root: Node): Node[] => [root, ...root.children.flatMap(all)]
const text = (root: Node): string => root.text + root.children.map(text).join('')
const record = (id: string, day: number, state: Partial<workspace.AiAssistantConversation> = {}): workspace.AiAssistantConversation => ({
  id, title: id, createdAt: new Date(2026, 10, day, 14).getTime(), updatedAt: new Date(2026, 10, day, 14).getTime(), messages: [], draft: '', ...state,
})
const mount = (records: workspace.AiAssistantConversation[]) => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = workspace.useWorkspaceStore()
  vi.spyOn(store, 'saveAiAssistantState').mockResolvedValue()
  store.aiAssistant.conversations = records
  const root = node('root')
  const app = renderer.createApp(page.default)
  app.use(pinia).mount(root)
  const title = (value: string) => all(root).find(n => n.tag === 'button' && text(n) === value)!
  const titles = () => all(root).filter(n => n.tag === 'article').map(n => text(all(n).find(item => item.tag === 'button')!))
  const click = async (button: Node) => { await (button.props.onClick as () => void | Promise<void>)(); await Vue.nextTick() }
  return { app, root, title, titles, click, store }
}

it('历史对话和索引库的页面背景使用同一主题色', () => {
  const pageBackground = (path: string) => {
    const page = parse(readFileSync(new URL(path, import.meta.url), 'utf8')).descriptor
    return page.template?.content.trimStart().match(/^<div class="([^"]+)"/)?.[1]
      .split(/\s+/).find(name => name.startsWith('bg-'))
  }
  const indexBackground = pageBackground('../../rag/RagIndexPage.vue')
  expect(indexBackground).toBeDefined()
  expect(pageBackground('../AiConversationHistoryPage.vue')).toBe(indexBackground)
})

it('搜索框和历史对话标题位于同一行，搜索框在标题右侧', () => {
  const { app, root } = mount([])
  try {
    const heading = all(root).find(n => n.tag === 'h1')!
    const search = all(root).find(n => n.props.type === 'search')!
    expect(heading.parent?.children.map(n => n.tag)).toEqual(['h1', 'label'])
    expect(search.parent?.parent === heading.parent).toBe(true)
  } finally { app.unmount() }
})

it('置顶立即提到菜单和日期列表之前，取消后按原本的日期回归', async () => {
  const { app, root, title, titles, click, store } = mount([record('较新对话', 23), record('较早对话', 21), record('更早对话', 19)])
  const row = (name: string) => all(root).find(n => n.tag === 'article' && all(n).includes(title(name)))!
  const action = (name: string, label: string) => all(row(name)).find(n => n.props.title === label)!
  try {
    await click(action('较早对话', '置顶'))
    expect(titles()).toEqual(['较早对话', '较新对话', '更早对话'])
    const search = all(root).find(n => n.props.placeholder === '搜索标题或最近问题')!
    expect(all(root).indexOf(search)).toBeLessThan(all(root).indexOf(row('较早对话')))
    expect(all(root).indexOf(row('较早对话'))).toBeLessThan(all(root).indexOf(row('较新对话')))
    expect(store.aiAssistant.conversations[1].updatedAt).toBe(record('', 21).updatedAt)
    await click(action('较早对话', '取消置顶'))
    expect(titles()).toEqual(['较新对话', '较早对话', '更早对话'])
    expect(all(root).filter(n => n.tag === 'time' && n.props.datetime === '2026-11-21')).toHaveLength(1)
  } finally { app.unmount() }
})

it('置顶区默认展开，可折叠且不影响时间线，搜索后恢复浏览时的折叠状态', async () => {
  const { app, root, titles, click } = mount([
    record('置顶样例', 21, { pinned: true }), record('普通样例', 22),
  ])
  const toggle = () => all(root).find(n => n.tag === 'button' && 'aria-expanded' in n.props)
  try {
    expect(toggle()?.props['aria-expanded']).toBe(true)
    expect(titles()).toEqual(['置顶样例', '普通样例'])
    await click(toggle()!)
    expect(toggle()?.props['aria-expanded']).toBe(false)
    expect(text(toggle()!)).toContain('置顶对话 · 1')
    expect(titles()).toEqual(['普通样例'])

    const search = all(root).find(n => n.props.type === 'search')!
    const setQuery = search.props['onUpdate:modelValue'] as (value: string) => void
    setQuery('置顶')
    await Vue.nextTick()
    expect(toggle()?.props['aria-expanded']).toBe(true)
    expect(titles()).toEqual(['置顶样例'])
    await click(toggle()!)
    expect(toggle()?.props['aria-expanded']).toBe(false)
    expect(text(root)).toContain('全部对话中找到 1 个结果')

    setQuery('')
    await Vue.nextTick()
    expect(toggle()?.props['aria-expanded']).toBe(false)
    expect(titles()).toEqual(['普通样例'])
    await click(toggle()!)
    expect(titles()).toEqual(['置顶样例', '普通样例'])
  } finally { app.unmount() }
})

it('时间线不提供置顶筛选，计数也不包含上方的置顶对话', () => {
  const { app, root } = mount([record('上方置顶', 23, { pinned: true, favorite: true }), record('普通对话', 22)])
  try {
    const controls = all(root).find(n => n.props['aria-label'] === '对话状态筛选')!
    const filters = all(controls).filter(n => n.tag === 'button' && 'aria-pressed' in n.props).map(text)
    expect(filters).toEqual(['全部 1', '收藏 0', '归档 0'])
    expect(text(root)).toContain('共 1 个对话')
  } finally { app.unmount() }
})

it('收藏分类和状态筛选只影响下方时间线', async () => {
  const { app, root, click } = mount([
    record('上方置顶', 23, { pinned: true, favorite: true, favoriteCategory: '置顶专属分类' }),
    record('普通对话', 22),
    record('项目对话', 21, { favorite: true, favoriteCategory: '项目' }),
    record('归档对话', 20, { pinned: true, archived: true }),
  ])
  const section = (label: string) => all(root).find(n => n.tag === 'section' && n.props['aria-label'] === label)!
  const dates = section('日期列表')
  const pins = section('置顶对话')
  const filter = (label: string) => all(dates).find(n => n.tag === 'button' && text(n).startsWith(`${label} `))!
  const update = async (field: Node, value: string) => {
    const setValue = field.props['onUpdate:modelValue'] as (value: string) => void
    setValue(value)
    await Vue.nextTick()
  }
  const category = all(dates).find(n => n.tag === 'select')!
  try {
    expect(text(category)).not.toContain('置顶专属分类')
    await update(category, '项目')
    expect(text(dates)).toContain('项目对话')
    expect(text(dates)).not.toContain('普通对话')
    expect(section('置顶对话') === pins).toBe(true)
    await update(category, 'all')
    await click(filter('收藏'))
    expect(text(dates)).toContain('项目对话')
    expect(text(dates)).not.toContain('普通对话')
    expect(section('置顶对话') === pins).toBe(true)
    await click(filter('归档'))
    expect(text(dates)).toContain('归档对话')
    expect(text(dates)).not.toContain('项目对话')
    expect(section('置顶对话') === pins).toBe(true)
    expect(text(pins)).toContain('上方置顶')
    expect(text(pins)).not.toContain('归档对话')
  } finally { app.unmount() }
})

it('顶部搜索按标题和最近问题查遍置顶、普通、归档对话，清空后恢复筛选', async () => {
  const { app, root, titles, click, title } = mount([
    record('关键词 · 置顶', 19, { pinned: true }),
    record('另一条置顶', 18, { pinned: true }),
    record('普通对话', 22, { messages: [{ id: 1, role: 'user', text: '最近的问题包含关键词', createdAt: 1 }] }),
    record('关键词 · 归档', 21, { archived: true, pinned: true }),
    record('收藏对话', 20, { favorite: true }),
  ])
  try {
    await click(title('收藏 1'))
    const search = all(root).find(n => n.tag === 'input')!
    const setValue = search.props['onUpdate:modelValue'] as (value: string) => void
    setValue(' 关键词 ')
    await Vue.nextTick()
    expect(titles()).toEqual(['关键词 · 置顶', '普通对话', '关键词 · 归档'])
    setValue('置顶')
    await Vue.nextTick()
    expect(titles()).toEqual(['关键词 · 置顶', '另一条置顶'])
    expect(text(root)).not.toContain('暂无匹配的历史对话')
    setValue('找不到的对话')
    await Vue.nextTick()
    expect(titles()).toEqual([])
    expect(text(root)).toContain('暂无匹配的历史对话')
    setValue(' ')
    await Vue.nextTick()
    expect(titles()).toEqual(['关键词 · 置顶', '另一条置顶', '收藏对话'])
  } finally { app.unmount() }
})

it('当前收藏分类的最后一条对话置顶后，恢复全部分类', async () => {
  const { app, root, click, titles } = mount([
    record('项目对话', 22, { favorite: true, favoriteCategory: '项目' }),
    record('普通对话', 21),
  ])
  try {
    const category = all(root).find(n => n.tag === 'select')!
    const setValue = category.props['onUpdate:modelValue'] as (value: string) => void
    setValue('项目')
    await Vue.nextTick()
    expect(titles()).toEqual(['项目对话'])
    await click(all(root).find(n => n.props.title === '置顶')!)
    expect(titles()).toEqual(['项目对话', '普通对话'])
  } finally { app.unmount() }
})

it('置顶区和时间线均无勾选框或页码，可手动加载更早对话', async () => {
  const { app, root, titles, click, title } = mount([
    record('置顶对话', 1, { pinned: true }), ...Array.from({ length: 9 }, (_, i) => record(`日常 ${i}`, 20 - i)),
  ])
  try {
    expect(all(root).filter(n => n.tag === 'input' && n.props.type === 'checkbox')).toHaveLength(0)
    expect(titles()).toEqual(['置顶对话', ...Array.from({ length: 8 }, (_, i) => `日常 ${i}`)])
    expect(all(root).some(n => n.props['aria-current'] === 'page')).toBe(false)
    await click(title('加载更早对话'))
    expect(titles()).toEqual(['置顶对话', ...Array.from({ length: 9 }, (_, i) => `日常 ${i}`)])
    expect(text(root)).toContain('已显示全部对话')
  } finally { app.unmount() }
})

it('触底追加时间线，保留已显示节点和日期分组，并在搜索时重置', async () => {
  const observers: Array<{ fire: (visible: boolean) => void; disconnect: () => void; root: unknown }> = []
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn()
    disconnect = vi.fn()
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void, options: IntersectionObserverInit) {
      observers.push({ fire: visible => callback([{ isIntersecting: visible }]), disconnect: this.disconnect, root: options.root })
    }
  })
  const { app, root, titles } = mount(Array.from({ length: 18 }, (_, i) => record(`日常 ${i}`, 21)))
  try {
    await Vue.nextTick()
    const currentObserver = () => observers.at(-1)!
    const first = currentObserver()
    expect(Boolean(first)).toBe(true)
    expect(first.root === root.children[0]).toBe(true)
    const articles = () => all(root).filter(n => n.tag === 'article')
    const initial = articles()
    expect(initial).toHaveLength(8)
    first.fire(false)
    await Vue.nextTick()
    expect(articles()).toHaveLength(8)
    first.fire(true)
    first.fire(true)
    await Vue.nextTick()
    expect(first.disconnect).toHaveBeenCalledTimes(1)
    expect(articles()).toHaveLength(16)
    expect(initial.every((node, index) => node === articles()[index])).toBe(true)
    expect(all(root).filter(n => n.tag === 'time' && n.props.datetime === '2026-11-21')).toHaveLength(1)

    currentObserver().fire(true)
    await Vue.nextTick()
    expect(titles()).toEqual(Array.from({ length: 18 }, (_, i) => `日常 ${i}`))
    const search = all(root).find(n => n.props.type === 'search')!
    const setQuery = search.props['onUpdate:modelValue'] as (value: string) => void
    setQuery('日常')
    await Vue.nextTick()
    expect(articles()).toHaveLength(8)
    first.fire(true)
    await Vue.nextTick()
    expect(articles()).toHaveLength(8)
  } finally {
    app.unmount()
    vi.unstubAllGlobals()
  }
  expect(observers.at(-1)?.disconnect).toHaveBeenCalledTimes(1)
})

const change = async (field: Node, value: string) => {
  (field.props['onUpdate:modelValue'] as (value: string) => void)(value)
  await Vue.nextTick()
}

it('按本地最后更新日期检索，包含两端且不影响顶部置顶', async () => {
  const { app, root, titles, title, click } = mount([
    record('顶部置顶', 16, { pinned: true }), record('太新', 24),
    record('结束日午夜前', 23, { updatedAt: new Date(2026, 10, 23, 23, 59).getTime() }),
    record('起始日零点', 21, { updatedAt: new Date(2026, 10, 21).getTime() }), record('太旧', 20),
  ])
  const field = (label: string) => all(root).find(n => n.props['aria-label'] === label)!
  try {
    await change(field('开始日期'), '2026-11-21')
    expect(titles()).toEqual(['顶部置顶', '太新', '结束日午夜前', '起始日零点'])
    await change(field('结束日期'), '2026-11-23')
    expect(titles()).toEqual(['顶部置顶', '结束日午夜前', '起始日零点'])
    await change(field('结束日期'), '2026-11-20')
    expect(titles()).toEqual(['顶部置顶'])
    expect(text(root)).toContain('结束日期不能早于开始日期')
    await click(title('清除日期'))
    expect(titles()).toHaveLength(5)
  } finally { app.unmount() }
})

const clickRow = async (row: Node, insideButton = false) => {
  const handler = row.props.onClick as ((event: MouseEvent) => void) | undefined
  handler?.({ target: { closest: (selector: string) => selector === 'button' && insideButton ? {} : null } } as unknown as MouseEvent)
  await Vue.nextTick()
}

it.each([false, true])('普通模式点击对话条目的非按钮区域会切换对话（置顶：%s）', async (pinned) => {
  const { app, root, store, title } = mount([record('当前对话', 23), record('目标对话', 22, { pinned })])
  try {
    store.setActiveAiAssistantConversation('当前对话')
    const row = all(root).find(n => n.tag === 'article' && all(n).includes(title('目标对话')))!
    await clickRow(row, true)
    expect(store.aiAssistant.activeConversationId).toBe('当前对话')
    await clickRow(row)
    expect(store.aiAssistant.activeConversationId).toBe('目标对话')
    expect(store.activeAuxiliaryPanel).toBe('ai')
  } finally { app.unmount() }
})

it('批量模式用非交互的绿色钩标记选中，只对已选对话执行操作', async () => {
  const { app, root, store, titles, title, click } = mount([
    record('甲', 23), record('乙', 22), record('丙', 21),
  ])
  const byLabel = (label: string) => all(root).find(n => n.props['aria-label'] === label)!
  const row = (name: string) => all(root).find(n => n.tag === 'article' && all(n).includes(title(name)))!
  const checkmark = (name: string) => all(row(name)).find(n => n.tag === 'svg' && n.props.class === 'history-crayon-check')
  try {
    await click(title('批量操作'))
    await clickRow(row('甲'))
    await clickRow(row('丙'))
    expect(checkmark('甲')?.parent?.tag).toBe('div')
    expect(checkmark('甲')?.parent?.props.onClick).toBeUndefined()
    expect(checkmark('乙')).toBeUndefined()
    expect(text(root)).toContain('已选 2 项')
    await change(byLabel('批量操作类型'), 'delete')
    const cancel = click(title('执行'))
    expect(store.confirmationDialogMessage).toContain('2 条')
    store.cancelConfirmation()
    await cancel
    expect(titles()).toEqual(['甲', '乙', '丙'])
    const confirm = click(title('执行'))
    store.acceptConfirmation()
    await confirm
    expect(titles()).toEqual(['乙'])
    expect(store.saveAiAssistantState).toHaveBeenCalledTimes(1)
  } finally { app.unmount() }
})

it('批量模式点击空白只切换批量选中，标题和最近问题切换对话', async () => {
  const { app, root, title, click, store } = mount([
    record('空白区样例', 23, { messages: [{ id: 1, role: 'user', text: '最近问题样例', createdAt: 1 }] }),
    record('当前对话', 22),
  ])
  const row = () => all(root).find(n => n.tag === 'article' && all(n).includes(title('空白区样例')))!
  const isSelected = () => all(row()).some(n => n.props.class === 'history-crayon-check')
  try {
    store.setActiveAiAssistantConversation('当前对话')
    await click(title('批量操作'))
    expect(isSelected()).toBe(false)
    await clickRow(row())
    expect(isSelected()).toBe(true)
    expect(store.aiAssistant.activeConversationId).toBe('当前对话')
    await clickRow(row(), true)
    expect(isSelected()).toBe(true)
    expect(store.aiAssistant.activeConversationId).toBe('当前对话')
    for (const label of ['空白区样例', '最近问题样例']) {
      store.setActiveAiAssistantConversation('当前对话')
      await click(title(label))
      expect(store.aiAssistant.activeConversationId).toBe('空白区样例')
      expect(isSelected()).toBe(true)
    }
    await clickRow(row())
    expect(isSelected()).toBe(false)
    expect(row().props.tabindex).toBe(0)
    const preventDefault = vi.fn()
    const keydown = row().props.onKeydown as (event: unknown) => void
    const focusedRow = row()
    keydown({ key: ' ', target: focusedRow, currentTarget: focusedRow, preventDefault })
    await Vue.nextTick()
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(isSelected()).toBe(true)
  } finally { app.unmount() }
})

it('批量菜单没有置顶操作，置顶及已归档的置顶对话均不可批选', async () => {
  const { app, root, store, title, click } = mount([
    record('范围：普通', 23), record('范围：置顶', 22, { pinned: true }),
    record('范围：归档置顶', 21, { pinned: true, archived: true }),
  ])
  const row = (name: string) => all(root).find(n => n.tag === 'article' && all(n).includes(title(name)))!
  const mark = (name: string) => all(row(name)).find(n => n.props.class === 'history-selection-mark')
  try {
    const search = all(root).find(n => n.props.type === 'search')!
    const setQuery = search.props['onUpdate:modelValue'] as (value: string) => void
    setQuery('范围')
    await Vue.nextTick()
    await click(title('批量操作'))
    const menu = all(root).find(n => n.props['aria-label'] === '批量操作类型')!
    expect(all(menu).filter(n => n.tag === 'option' && n.props.value).map(n => n.props.value))
      .toEqual(['favorite', 'unfavorite', 'archive', 'unarchive', 'delete'])
    for (const name of ['范围：置顶', '范围：归档置顶']) {
      await clickRow(row(name))
      expect(row(name).props.tabindex).toBeUndefined()
      expect(mark(name)).toBeUndefined()
    }
    await change(menu, 'delete')
    expect(title('执行').props.disabled).toBe(true)
    await clickRow(row('范围：普通'))
    expect(text(root)).toContain('已选 1 项')
    store.togglePinAiAssistantConversation('范围：普通')
    await Vue.nextTick()
    expect(title('执行').props.disabled).toBe(true)
    store.togglePinAiAssistantConversation('范围：普通')
    await Vue.nextTick()
    expect(title('执行').props.disabled).toBe(true)
    await clickRow(row('范围：普通'))
    expect(text(root)).toContain('已选 1 项')
  } finally { app.unmount() }
})

it('批量删除确认期间置顶的对话不会被删除', async () => {
  const { app, root, store, title, titles, click } = mount([record('保留', 23), record('删除', 22)])
  try {
    await click(title('批量操作'))
    for (const row of all(root).filter(n => n.tag === 'article')) await clickRow(row)
    await change(all(root).find(n => n.props['aria-label'] === '批量操作类型')!, 'delete')
    const pending = click(title('执行'))
    store.togglePinAiAssistantConversation('保留')
    store.acceptConfirmation()
    await pending
    expect(titles()).toEqual(['保留'])
  } finally { app.unmount() }
})

it('批量删除等待确认期间若重新载入工作空间，不删除新列表中的同 ID 对话', async () => {
  const { app, root, store, title, titles, click } = mount([record('同一 ID', 23)])
  const byLabel = (label: string) => all(root).find(n => n.props['aria-label'] === label)!
  try {
    await click(title('批量操作'))
    await clickRow(all(root).find(n => n.tag === 'article')!)
    await change(byLabel('批量操作类型'), 'delete')
    const pending = click(title('执行'))
    store.aiAssistantLoadRequestId++
    store.aiAssistant.conversations = [record('同一 ID', 22, { title: '新列表对话' })]
    store.acceptConfirmation()
    await pending
    expect(titles()).toEqual(['新列表对话'])
    expect(store.saveAiAssistantState).not.toHaveBeenCalled()
  } finally { app.unmount() }
})

it('单条删除仍需确认，且只删除该对话', async () => {
  const { app, root, titles, click, store } = mount([record('保留对话', 23), record('待删对话', 21, { pinned: true })])
  const remove = () => all(root).find(n => n.tag === 'article' && text(n).includes('待删对话'))!.children
    .flatMap(all).find(n => n.props.title === '删除')!
  try {
    const cancel = click(remove())
    expect(store.confirmationDialogMessage).toContain('待删对话')
    store.cancelConfirmation()
    await cancel
    expect(titles()).toEqual(['待删对话', '保留对话'])
    const confirm = click(remove())
    store.acceptConfirmation()
    await confirm
    expect(titles()).toEqual(['保留对话'])
  } finally { app.unmount() }
})
