import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'
import { createFileTab } from '../workspace-tab-utils'

describe('workspace runtime state cleanup', () => {
  beforeEach(() => { setActivePinia(createPinia()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('does not replace or persist messages when index action availability is unchanged', () => {
    const store = useWorkspaceStore()
    const conversation = store.ensureActiveAiAssistantConversation()
    conversation.messages = [{ id: 1, role: 'assistant', text: '', createdAt: 1, actions: [
      { type: 'build-index', title: '', description: '', buttonText: '' },
    ] }]
    const messages = conversation.messages
    const save = vi.spyOn(store, 'saveAiAssistantState').mockImplementation(() => {})
    const touch = vi.spyOn(store, 'touchAiAssistantConversation')
    store.setAiAssistantActionDisabled('build-index', false)
    expect(conversation.messages).toBe(messages)
    expect(save).not.toHaveBeenCalled()
    expect(touch).not.toHaveBeenCalled()
    store.setAiAssistantActionDisabled('build-index', true)
    expect(conversation.messages[0].actions?.[0].disabled).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    store.setAiAssistantActionDisabled('build-index', true)
    expect(save).toHaveBeenCalledTimes(1)
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
