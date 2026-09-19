import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'
import { createFileTab } from '../workspace-tab-utils'

const tabIds = (paths: string[]) => paths.map((path) => createFileTab(path).id)

const prepareStore = () => {
  const store = useWorkspaceStore()
  store.tabs = ['a.md', 'b.md', 'c.md', 'd.md'].map(createFileTab)
  store.activeTabId = createFileTab('c.md').id
  return store
}

describe('workspace tab closing', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('closes only tabs to the left of the selected tab', async () => {
    const store = prepareStore()

    await store.closeTabsToLeft(createFileTab('c.md').id)

    expect(store.tabs.map((tab) => tab.id)).toEqual(tabIds(['c.md', 'd.md']))
    expect(store.activeTabId).toBe(createFileTab('c.md').id)
  })

  it('closes all tabs except the selected tab', async () => {
    const store = prepareStore()

    await store.closeOtherTabs(createFileTab('c.md').id)

    expect(store.tabs.map((tab) => tab.id)).toEqual(tabIds(['c.md']))
    expect(store.activeTabId).toBe(createFileTab('c.md').id)
  })

  it('wires both actions into the tab context menu', () => {
    const editorTabs = readFileSync(resolve(process.cwd(), 'src/renderer/components/EditorTabs.vue'), 'utf8')

    expect(editorTabs).toContain("closeTabs('left')")
    expect(editorTabs).toContain('关闭左侧标签页')
    expect(editorTabs).toContain("closeTabs('other')")
    expect(editorTabs).toContain('closeDocumentTabs(')
    expect(editorTabs).toContain('externalDocuments.close(doc.id)')
    expect(editorTabs).toContain('@contextmenu="(e) => onContextMenu(e, doc)"')
    expect(editorTabs).toContain('关闭其他标签页')
  })
})
