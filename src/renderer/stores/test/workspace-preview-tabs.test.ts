import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'
import { createFileTab } from '../workspace-tab-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const id = (path: string) => createFileTab(path).id
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const prepareStore = () => {
  const store = useWorkspaceStore()
  vi.spyOn(store, 'saveWorkspaceMeta').mockResolvedValue()
  return store
}

describe('preview tabs', () => {
  beforeEach(() => { setActivePinia(createPinia()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('rejects delayed editor events after removal, reopening and workspace changes', async () => {
    const store = prepareStore()
    store.activeWorkspaceId = 'ws'
    store.openPreviewFileTab('a.md')
    const diskState = { content: 'disk', loadedContent: 'disk', isSaving: false, saveError: '', loadRequestId: 1 }
    store.openedTextFileContents['a.md'] = diskState
    const save = vi.spyOn(store, 'saveActiveFileContent').mockResolvedValue({ success: true })
    const oldEditor = store.createTextFileEditorBinding('a.md')
    store.openPreviewFileTab('b.md')
    oldEditor.events['update:content']('late')
    await oldEditor.events.save('late')
    expect(store.openedTextFileContents['a.md']).toBeUndefined()
    store.openPreviewFileTab('a.md')
    store.openedTextFileContents['a.md'] = { ...diskState, loadRequestId: 2 }
    const newEditor = store.createTextFileEditorBinding('a.md')
    expect(newEditor.key).not.toBe(oldEditor.key)
    oldEditor.events['edit-pending']()
    oldEditor.events['update:content']('stale')
    await oldEditor.events.save('stale')
    expect(store.openedTextFileContents['a.md'].content).toBe('disk')
    expect(store.previewTabId).toBe(id('a.md'))
    expect(save).not.toHaveBeenCalled()
    newEditor.events['edit-pending']()
    expect(store.previewTabId).toBe('')
    store.activeWorkspaceId = 'other'
    await newEditor.events.save('wrong workspace')
    expect(save).not.toHaveBeenCalled()
  })

  it('binds KeepAlive keys and events to a captured editor instance rather than the active path', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/renderer/components/MainContent.vue'), 'utf8')
    expect(main).toContain('workspaceStore.createTextFileEditorBinding(relativePath)')
    expect(main).toContain('activeTextEditor.binding.key')
    expect(main).toContain('v-on="activeTextEditor.binding.events"')
    expect(main).not.toContain('const handleSave =')
  })

  it('ignores late text reads after preview replacement and reopening the same path', async () => {
    const store = prepareStore()
    store.workspaces = [{ id: 'ws', name: 'Notes', path: '/notes', createdAt: 1, lastOpenedAt: 1 }]
    store.activeWorkspaceId = 'ws'
    const oldRead = deferred<{ success: true; data: string }>()
    const newRead = deferred<{ success: true; data: string }>()
    vi.stubGlobal('window', { electronAPI: { file: { readMarkdown: vi.fn().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise) } } })
    store.openPreviewFileTab('a.txt')
    store.openPreviewFileTab('b.png')
    store.openPreviewFileTab('a.txt')
    newRead.resolve({ success: true, data: 'new disk' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    oldRead.resolve({ success: true, data: 'old disk' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.openedTextFileContents['a.txt'].content).toBe('new disk')
    store.openPreviewFileTab('b.png')
    expect(store.openedTextFileContents['a.txt']).toBeUndefined()
  })

  it('does not apply a stale recovery result to a reopened file', async () => {
    const store = prepareStore()
    store.activeWorkspaceId = 'ws'
    store.openPreviewFileTab('a.md')
    const diskState = { content: 'disk', loadedContent: 'disk', isSaving: false, saveError: '', loadRequestId: 1 }
    store.openedTextFileContents['a.md'] = diskState
    const recovery = deferred<unknown>()
    vi.stubGlobal('window', { electronAPI: { draftRecovery: { get: vi.fn().mockReturnValue(recovery.promise) } } })
    const pending = store.restoreDraftRecovery('a.md', 'disk')
    store.openPreviewFileTab('b.md')
    store.openPreviewFileTab('a.md')
    store.openedTextFileContents['a.md'] = { ...diskState, loadRequestId: 2 }
    recovery.resolve({ success: true, data: { status: 'recovered', draft: { draftContent: 'stale', revision: 'r1' } } })
    await pending
    expect(store.openedTextFileContents['a.md'].content).toBe('disk')
    expect(store.previewTabId).toBe(id('a.md'))
  })

  it('wires file single-click preview and explicit double-click retention with a visible preview label', () => {
    const tree = readFileSync(resolve(process.cwd(), 'src/renderer/components/FileTree.vue'), 'utf8')
    const tabs = readFileSync(resolve(process.cwd(), 'src/renderer/components/EditorTabs.vue'), 'utf8')
    expect(tree).toContain('workspaceStore.openPreviewFileTab(row.relativePath)')
    expect(tree).toContain('@dblclick.exact=')
    expect(tree).toContain('!row.entry.isDirectory && workspaceStore.openFileTab(row.entry.relativePath)')
    expect(tree).toContain('if (isMulti) return')
    expect(tabs).toContain('@dblclick="workspaceStore.retainTab(tab.id)"')
    expect(tabs).toContain("{ italic: workspaceStore.previewTabId === tab.id }")
    expect(tabs).toContain('预览，双击保留')
  })

  it('isolates rename double-clicks and allows Chinese preview titles to synthesize italics', () => {
    const tree = readFileSync(resolve(process.cwd(), 'src/renderer/components/FileTree.vue'), 'utf8')
    const inputs = tree.match(/<input\b[\s\S]*?\/>/g) || []
    expect(inputs.length).toBeGreaterThan(0)
    for (const input of inputs) expect(input).toContain('@dblclick.stop')
    const tabs = readFileSync(resolve(process.cwd(), 'src/renderer/components/EditorTabs.vue'), 'utf8')
    expect(tabs).toMatch(/\.italic\s*\{[^}]*font-synthesis:\s*style/)
  })

  it('retains a recovered dirty draft', async () => {
    const store = prepareStore()
    store.openPreviewFileTab('a.md')
    store.activeWorkspaceId = 'ws'
    store.openedTextFileContents['a.md'] = { content: 'disk', loadedContent: 'disk', isSaving: false, saveError: '', loadRequestId: 1 }
    vi.stubGlobal('window', { electronAPI: { draftRecovery: { get: vi.fn().mockResolvedValue({ success: true, data: { status: 'recovered', draft: { draftContent: 'draft', revision: 'r1' } } }) } } })
    await store.restoreDraftRecovery('a.md', 'disk')
    expect(store.isFileDirty('a.md')).toBe(true)
    expect(store.previewTabId).toBe('')
  })

  it('replaces the sole preview in place without downgrading permanent tabs', () => {
    const store = prepareStore()
    store.openFileTab('left.md')
    store.openPreviewFileTab('a.md')
    store.openFileTab('right.md')
    store.openPreviewFileTab('b.md')
    expect(store.tabs.map((tab) => tab.id)).toEqual(['left.md', 'b.md', 'right.md'].map(id))
    expect(store.previewTabId).toBe(id('b.md'))
    store.openPreviewFileTab('left.md')
    expect(store.activeTabId).toBe(id('left.md'))
    expect(store.previewTabId).toBe(id('b.md'))
    store.openFileTab('b.md')
    expect(store.previewTabId).toBe('')
    store.openPreviewFileTab('c.md')
    expect(store.tabs).toHaveLength(4)
  })

  it.each(['pending', 'content'])('retains immediately on %s edits', (kind) => {
    const store = prepareStore()
    store.openPreviewFileTab('a.md')
    store.openedTextFileContents['a.md'] = { content: 'old', loadedContent: 'old', isSaving: false, saveError: '' }
    if (kind === 'pending') store.markTextFileEditPending('a.md')
    else store.setActiveFileContent('new', 'a.md')
    expect(store.previewTabId).toBe('')
    store.openPreviewFileTab('b.md')
    expect(store.tabs.map((tab) => tab.id)).toEqual(['a.md', 'b.md'].map(id))
  })

  it('keeps the preview pointer valid across reorder, move, removal and close', async () => {
    const store = prepareStore()
    store.openFileTab('kept.md')
    store.openPreviewFileTab('dir/a.md')
    store.setTabs([...store.tabs].reverse())
    expect(store.previewTabId).toBe(id('dir/a.md'))
    store.syncOpenedFilesAfterMove([{ from: 'dir', to: 'renamed' }])
    expect(store.previewTabId).toBe(id('renamed/a.md'))
    store.syncOpenedFilesAfterRemoval(['renamed'])
    expect(store.previewTabId).toBe('')
    store.openPreviewFileTab('b.md')
    await store.closeTab(id('b.md'))
    expect(store.previewTabId).toBe('')
    store.openPreviewFileTab('c.md')
    store.setTabs([createFileTab('kept.md')])
    expect(store.previewTabId).toBe('')
  })

  it('clears the preview marker before restoring permanent workspace tabs', async () => {
    const store = prepareStore()
    store.openPreviewFileTab('a.md')
    vi.stubGlobal('window', { electronAPI: { workspaceMeta: { get: vi.fn().mockResolvedValue({ success: true, data: { tabs: [createFileTab('a.md')] } }) } } })
    vi.spyOn(store, 'loadAiAssistantState').mockResolvedValue()
    await store.loadWorkspaceMeta('other')
    expect(store.previewTabId).toBe('')
    store.openPreviewFileTab('b.md')
    expect(store.tabs.map((tab) => tab.id)).toEqual(['a.md', 'b.md'].map(id))
    vi.unstubAllGlobals()
  })
})
