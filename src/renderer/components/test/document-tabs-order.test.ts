import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import { createPinia } from 'pinia'
import { expect, it, vi } from 'vitest'
import { closeDocumentTabs } from '../../utils/document-tab-closing'
import { useWorkspaceStore } from '../../stores/workspace'
import { useExternalDocumentsStore } from '../../stores/externalDocuments'
import { createFileTab, createSystemTab } from '../../stores/workspace-tab-utils'

it('uses one visual order for bidirectional mixed dragging, persistence and cancellable closing', async () => {
  const closed: string[] = []
  const pinia = createPinia()
  const workspace = useWorkspaceStore(pinia)
  const external = useExternalDocumentsStore(pinia)
  const file = createFileTab('a.md')
  const help = createSystemTab('help')
  const a = file.id
  const h = help.id
  const makeExternal = (id: string) => ({ id, filePath: `/${id}.md`, content: '', baseContent: '', pending: false, saving: false, error: '', recoveryError: '' })
  workspace.setTabs([file, help], a)
  external.documents = ['x', 'y'].map(makeExternal)
  vi.spyOn(workspace, 'saveWorkspaceMeta').mockResolvedValue()
  vi.spyOn(workspace, 'closeTab').mockImplementation(async id => { closed.push(id); return true })
  vi.spyOn(external, 'close').mockImplementation(async id => { closed.push(id); return false })
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
    expect(api.order()).toEqual([h, a, 'x', 'y'])
    // The displaced tab is still under the stationary pointer during FLIP.
    hover(181, 0)
    hover(181, 0)
    expect(api.order()).toEqual([h, a, 'x', 'y'])
    // Moving back across its layout midpoint must still allow reversal.
    hover(59, 0)
    expect(api.order()).toEqual([a, h, 'x', 'y'])
    api.onDragEnd()
    drag(2, 0)
    expect(api.order()).toEqual(['x', a, h, 'y'])
    drag(2, 0)
    expect(api.order()).toEqual([h, 'x', a, 'y'])
    drag(3, 1)
    expect(api.order()).toEqual([h, 'y', 'x', a])
    expect(workspace.tabs.map(t => t.id)).toEqual([h, a])
    expect(workspace.saveWorkspaceMeta).toHaveBeenCalled()
    api.contextMenuTabId.value = a
    await api.closeTabs('left')
    expect(closed).toEqual([h, 'y']) // Cancel prevents x from closing.
    closed.length = 0
    api.contextMenuTabId.value = 'y'
    await api.closeTabs('right')
    expect(closed).toEqual(['x'])
    // Workspace restoration can replace ordinary order while preserving the same IDs.
    workspace.tabs = [file, help]
    await vue.nextTick()
    expect(api.order().filter((id: string) => [a, h].includes(id))).toEqual([a, h])
    workspace.tabs = []
    await vue.nextTick()
    expect(api.order()).toEqual(['y', 'x'])
    drag(1, 0)
    expect(api.order()).toEqual(['x', 'y'])
    external.documents = ['y', 'z'].map(makeExternal)
    await vue.nextTick()
    expect(api.order()).toEqual(['y', 'z'])
  } finally { scope.stop() }
})
