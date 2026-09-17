import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'
import { createFileTab } from '../workspace-tab-utils'

describe('workspace runtime state cleanup', () => {
  beforeEach(() => { setActivePinia(createPinia()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('keeps historical index actions but discards persisted availability', async () => {
    const store = useWorkspaceStore()
    store.activeWorkspaceId = 'ws'
    const conversation = store.ensureActiveAiAssistantConversation()
    conversation.messages = [{ id: 1, role: 'assistant', text: '', createdAt: 1, actions: [
      { type: 'build-index', title: '', description: '', buttonText: '' },
    ] }]
    const saved = JSON.parse(JSON.stringify(store.aiAssistant))
    saved.conversations[0].messages[0].actions[0].disabled = true
    vi.stubGlobal('window', { electronAPI: { workspaceAi: {
      get: vi.fn().mockResolvedValue({ success: true, data: saved }),
    } } })
    const save = vi.spyOn(store, 'saveAiAssistantState').mockImplementation(() => {})
    await store.loadAiAssistantState('ws')
    expect(store.aiAssistant.conversations[0].messages[0].actions).toEqual([
      { type: 'build-index', title: '', description: '', buttonText: '' },
    ])
    expect(save).not.toHaveBeenCalled()
  })

  it('uses tabs as its runtime source and still writes legacy metadata', async () => {
    const store = useWorkspaceStore()
    const set = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('window', { electronAPI: { workspaceMeta: { set } } })
    store.activeWorkspaceId = 'ws'
    store.tabs = [createFileTab('note.md')]
    store.activeTabId = store.tabs[0].id
    store.syncLegacyTabState()
    expect(store.$state).not.toHaveProperty('openedFiles')
    expect(store.$state).not.toHaveProperty('openedSystemPages')
    await store.saveWorkspaceMeta()
    expect(set).toHaveBeenCalledWith('ws', expect.objectContaining({ openedFiles: ['note.md'] }))
  })
})
