import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import { expect, it, vi } from 'vitest'
import { closeDocumentTabs } from '../../utils/document-tab-closing'

it('uses one visual order for bidirectional mixed dragging, persistence and cancellable closing', async () => {
  const closed: string[] = []
  const workspace = vue.reactive({
    tabs: [{ id: 'a', kind: 'file' }, { id: 'help', kind: 'system' }], activeTabId: 'a', activeWorkspaceId: 'ws',
    setTabs: vi.fn((tabs: any[]) => { workspace.tabs = tabs }), saveWorkspaceMeta: vi.fn(async () => {}),
    isTabDirty: () => false, closeTab: async (id: string) => { closed.push(id); return true },
  })
  const external = vue.reactive({ documents: [{ id: 'x' }, { id: 'y' }],
    dirty: () => true, close: async (id: string) => { closed.push(id); return false },
  })
  const source = readFileSync(new URL('../EditorTabs.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const scope = vue.effectScope()
  const api = scope.run(() => new Function('require', 'exports', `${code}\nreturn { onDragStart, onDragOver, onDragEnd, closeTabs, contextMenuTabId, order: () => typeof visualTabs === 'undefined' ? [] : visualTabs.value.map(t => t.id) };`)((id: string) => {
    if (id === 'vue') return { ...vue, onMounted: vi.fn(), onUnmounted: vi.fn() }
    if (id.includes('stores/workspace')) return { useWorkspaceStore: () => workspace }
    if (id.includes('stores/externalDocuments')) return { useExternalDocumentsStore: () => external }
    if (id.includes('document-tab-closing')) return { closeDocumentTabs }
    return {}
  }, {}))!
  const hover = (clientX: number, targetIndex: number) => {
    const children = api.order().map((id: string, index: number) => ({ dataset: { documentTab: id }, offsetLeft: index * 120, offsetWidth: 120 }))
    api.onDragOver({ preventDefault() {}, clientX, currentTarget: {
      children, scrollLeft: 0, getBoundingClientRect: () => ({ left: 0 }),
    } }, targetIndex)
  }
  const drag = (from: number, to: number) => {
    api.onDragStart({}, from)
    hover(to * 120 + 60 + (to > from ? 1 : -1), to)
    api.onDragEnd()
  }
  try {
    api.onDragStart({}, 0)
    hover(181, 1)
    expect(api.order()).toEqual(['help', 'a', 'x', 'y'])
    // The displaced tab is still under the stationary pointer during FLIP.
    hover(181, 0)
    hover(181, 0)
    expect(api.order()).toEqual(['help', 'a', 'x', 'y'])
    // Moving back across its layout midpoint must still allow reversal.
    hover(59, 0)
    expect(api.order()).toEqual(['a', 'help', 'x', 'y'])
    api.onDragEnd()
    drag(2, 0)
    expect(api.order()).toEqual(['x', 'a', 'help', 'y'])
    drag(2, 0)
    expect(api.order()).toEqual(['help', 'x', 'a', 'y'])
    drag(3, 1)
    expect(api.order()).toEqual(['help', 'y', 'x', 'a'])
    expect(workspace.tabs.map(t => t.id)).toEqual(['help', 'a'])
    expect(workspace.saveWorkspaceMeta).toHaveBeenCalled()
    api.contextMenuTabId.value = 'a'
    await api.closeTabs('left')
    expect(closed).toEqual(['help', 'y']) // Cancel prevents x from closing.
    closed.length = 0
    api.contextMenuTabId.value = 'y'
    await api.closeTabs('right')
    expect(closed).toEqual(['x'])
    // Workspace restoration can replace ordinary order while preserving the same IDs.
    workspace.tabs = [{ id: 'a', kind: 'file' }, { id: 'help', kind: 'system' }]
    await vue.nextTick()
    expect(api.order().filter((id: string) => ['a', 'help'].includes(id))).toEqual(['a', 'help'])
    workspace.tabs = []
    await vue.nextTick()
    expect(api.order()).toEqual(['y', 'x'])
    drag(1, 0)
    expect(api.order()).toEqual(['x', 'y'])
    external.documents = [{ id: 'y' }, { id: 'z' }]
    await vue.nextTick()
    expect(api.order()).toEqual(['y', 'z'])
  } finally { scope.stop() }
})
