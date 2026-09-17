import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

describe('active text file projections', () => {
  beforeEach(() => { setActivePinia(createPinia()) })
  it('derives all active fields from the open file, including direct async updates', () => {
    const store = useWorkspaceStore()
    store.activeFileRelativePath = 'a.md'
    store.activeFilePath = '/ws/a.md'
    store.openedTextFileContents['a.md'] = { content: 'draft', loadedContent: 'disk', isSaving: true, saveError: 'error' }
    expect(store.activeFileContent).toBe('draft')
    expect(store.activeFileLoadedContent).toBe('disk')
    expect(store.activeFileIsSaving).toBe(true)
    expect(store.activeFileSaveError).toBe('error')
    expect(store.hasUnsavedChanges).toBe(true)
    expect(store.$state).not.toHaveProperty('activeFileContent')
    store.openedTextFileContents['a.md'].isPartial = true
    expect(store.hasUnsavedChanges).toBe(false)
    store.activeFileRelativePath = 'b.md'
    expect(store.activeFileContent).toBe('')
    expect(store.activeFileIsSaving).toBe(false)
    store.openedTextFileContents['a.md'].content = 'late update'
    expect(store.activeFileContent).toBe('')
    store.activeFileRelativePath = 'a.md'
    expect(store.activeFileContent).toBe('late update')
    store.resetActiveFileState()
    expect(store.activeFileContent).toBe('')
    expect(store.activeFileSaveError).toBe('')
  })
})
