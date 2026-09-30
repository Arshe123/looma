import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

describe('collapse all file tree folders', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as any).window = globalThis.window || globalThis
  })

  it('clears every expansion and persists it without changing the active file or selection', async () => {
    const setMeta = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).electronAPI = { workspaceMeta: { set: setMeta } }
    const store = useWorkspaceStore()
    store.workspaces = [{ id: 'ws', name: 'Notes', path: '/notes', createdAt: 1, lastOpenedAt: 1 }]
    store.activeWorkspaceId = 'ws'
    store.expandedDirs = ['docs', 'docs/nested', 'other']
    store.selectedPaths = ['docs/nested/note.md']
    store.activeFileRelativePath = 'docs/nested/note.md'
    const tabs = [...store.tabs]

    await store.collapseAllDirs()

    expect(store.expandedDirs).toEqual([])
    expect(store.activeExpandedSet.size).toBe(0)
    expect(store.selectedPaths).toEqual(['docs/nested/note.md'])
    expect(store.activeFileRelativePath).toBe('docs/nested/note.md')
    expect(store.tabs).toEqual(tabs)
    expect(setMeta).toHaveBeenCalledWith('ws', expect.objectContaining({ expandedDirs: [] }))
    await store.collapseAllDirs()
    expect(store.expandedDirs).toEqual([])
  })

  it('exposes the action through an accessible header button', () => {
    const source = readFileSync(new URL('../../components/FileTree.vue', import.meta.url), 'utf8')
    expect(source).toMatch(/<button\s[^>]*title="全部折叠"[^>]*aria-label="全部折叠"[^>]*@click="workspaceStore\.collapseAllDirs\(\)"[^>]*>/)
  })
})
